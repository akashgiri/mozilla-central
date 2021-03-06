/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

let EXPORTED_SYMBOLS = ["DOMApplicationRegistry", "DOMApplicationManifest"];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import('resource://gre/modules/ActivitiesService.jsm');
Cu.import("resource://gre/modules/AppsUtils.jsm");
Cu.import("resource://gre/modules/PermissionsTable.jsm");

function debug(aMsg) {
  //dump("-*-*- Webapps.jsm : " + aMsg + "\n");
}

const WEBAPP_RUNTIME = Services.appinfo.ID == "webapprt@mozilla.org";

// Permission access flags
const READONLY = "readonly";
const CREATEONLY = "createonly";
const READCREATE = "readcreate";
const READWRITE = "readwrite";

const PERM_TO_STRING = ["unknown", "allow", "deny", "prompt"];

XPCOMUtils.defineLazyServiceGetter(this,
                                   "PermSettings",
                                   "@mozilla.org/permissionSettings;1",
                                   "nsIDOMPermissionSettings");

XPCOMUtils.defineLazyGetter(this, "NetUtil", function() {
  Cu.import("resource://gre/modules/NetUtil.jsm");
  return NetUtil;
});

XPCOMUtils.defineLazyServiceGetter(this,
                                   "permissionManager",
                                   "@mozilla.org/permissionmanager;1",
                                   "nsIPermissionManager");

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                                   "@mozilla.org/parentprocessmessagemanager;1",
                                   "nsIMessageBroadcaster");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsIMessageSender");

XPCOMUtils.defineLazyGetter(this, "msgmgr", function() {
  return Cc["@mozilla.org/system-message-internal;1"]
         .getService(Ci.nsISystemMessagesInternal);
});

#ifdef MOZ_WIDGET_GONK
  const DIRECTORY_NAME = "webappsDir";
#elifdef ANDROID
  const DIRECTORY_NAME = "webappsDir";
#else
  // If we're executing in the context of the webapp runtime, the data files
  // are in a different directory (currently the Firefox profile that installed
  // the webapp); otherwise, they're in the current profile.
  const DIRECTORY_NAME = WEBAPP_RUNTIME ? "WebappRegD" : "ProfD";
#endif

/**
 * Determine the type of app (app, privileged, certified)
 * that is installed by the manifest
 * @param object aManifest
 * @returns integer
 **/
function getAppManifestStatus(aManifest)
{
  let type = aManifest.type || "web";

  switch(type) {
  case "web":
    return Ci.nsIPrincipal.APP_STATUS_INSTALLED;
  case "privileged":
    return Ci.nsIPrincipal.APP_STATUS_PRIVILEGED;
  case "certified":
    return Ci.nsIPrincipal.APP_STATUS_CERTIFIED;
  default:
    throw new Error("Webapps.jsm: Undetermined app manifest type");
  }
}

/**
 * Expand an access string into multiple permission names,
 *   e.g: perm 'contacts' with 'readwrite' =
 *   ['contacts-read', 'contacts-create', contacts-write']
 * @param string aPermName
 * @param string aAccess
 * @returns Array
 **/
function expandPermissions(aPermName, aAccess)
{
  if (!PermissionsTable[aPermName]) {
    Cu.reportError("Unknown permission: " + aPermName);
    throw new Error("Webapps.jsm: App install failed, Unknown Permission: " + aPermName);
  }
  if (!aAccess && PermissionsTable[aPermName].access ||
      aAccess && !PermissionsTable[aPermName].access) {
    Cu.reportError("Webapps.jsm: installPermissions: Invalid Manifest");
    throw new Error("Webapps.jsm: App install failed, Invalid Manifest");
  }
  if (!PermissionsTable[aPermName].access) {
    return [aPermName];
  }

  let requestedSuffixes = [];
  switch(aAccess) {
  case READONLY:
    requestedSuffixes.push("read");
    break;
  case CREATEONLY:
    requestedSuffixes.push("create");
    break;
  case READCREATE:
    requestedSuffixes.push("read", "create");
    break;
  case READWRITE:
    requestedSuffixes.push("read", "create", "write");
    break;
  default:
    return [];
  }

  let permArr = mapSuffixes(aPermName, requestedSuffixes);

  let expandedPerms = [];
  for (let idx in permArr) {
    if (PermissionsTable[aPermName].access.indexOf(requestedSuffixes[idx]) != -1) {
      expandedPerms.push(permArr[idx]);
    }
  }
  return expandedPerms;
}

let DOMApplicationRegistry = {
  appsFile: null,
  webapps: { },
  children: [ ],
  allAppsLaunchable: false,
  downloads: { },

  init: function() {
    this.messages = ["Webapps:Install", "Webapps:Uninstall",
                     "Webapps:GetSelf", "Webapps:IsInstalled",
                     "Webapps:GetInstalled", "Webapps:GetNotInstalled",
                     "Webapps:Launch", "Webapps:GetAll",
                     "Webapps:InstallPackage", "Webapps:GetBasePath",
                     "Webapps:GetList", "Webapps:RegisterForMessages",
                     "Webapps:UnregisterForMessages",
                     "Webapps:CancelDownload", "Webapps:CheckForUpdate"];

    this.frameMessages = ["Webapps:ClearBrowserData"];

    this.messages.forEach((function(msgName) {
      ppmm.addMessageListener(msgName, this);
    }).bind(this));

    cpmm.addMessageListener("Activities:Register:OK", this);

    Services.obs.addObserver(this, "xpcom-shutdown", false);

    this.appsFile = FileUtils.getFile(DIRECTORY_NAME,
                                      ["webapps", "webapps.json"], true);

    this.loadAndUpdateApps();
  },

  // loads the current registry, that could be empty on first run.
  // aNext() is called after we load the current webapps list.
  loadCurrentRegistry: function loadCurrentRegistry(aNext) {
    let file = FileUtils.getFile(DIRECTORY_NAME, ["webapps", "webapps.json"], false);
    if (file && file.exists) {
      this._loadJSONAsync(file, (function loadRegistry(aData) {
        if (aData) {
          this.webapps = aData;
          let appDir = FileUtils.getDir(DIRECTORY_NAME, ["webapps"], false);
          for (let id in this.webapps) {
            // Make sure we have a localId
            if (this.webapps[id].localId === undefined) {
              this.webapps[id].localId = this._nextLocalId();
            }

            if (this.webapps[id].basePath === undefined) {
              this.webapps[id].basePath = appDir.path;
            }

            // Default to removable apps.
            if (this.webapps[id].removable === undefined) {
              this.webapps[id].removable = true;
            }

            // Default to a non privileged status.
            if (this.webapps[id].appStatus === undefined) {
              this.webapps[id].appStatus = Ci.nsIPrincipal.APP_STATUS_INSTALLED;
            }
          };
        }
        aNext();
      }).bind(this));
    } else {
      aNext();
    }
  },

  // We are done with loading and initializing. Notify and
  // save a copy of the registry.
  onInitDone: function onInitDone() {
    Services.obs.notifyObservers(this, "webapps-registry-ready", null);
    this._saveApps();
  },

  // registers all the activities and system messages
  registerAppsHandlers: function registerAppsHandlers() {
#ifdef MOZ_SYS_MSG
    let ids = [];
    for (let id in this.webapps) {
      ids.push({ id: id });
    }
    this._processManifestForIds(ids);
#else
    // Nothing else to do but notifying we're ready.
    this.onInitDone();
#endif
  },

  // Implements the core of bug 787439
  // 1. load the apps from the current registry.
  // 2. if at first run, go through these steps:
  //   a. load the core apps registry.
  //   b. uninstall any core app from the current registry but not in the
  //      new core apps registry.
  //   c. for all apps in the new core registry, install them if they are not
  //      yet in the current registry, and run installPermissions()
  loadAndUpdateApps: function loadAndUpdateApps() {
    let runUpdate = Services.prefs.getBoolPref("dom.mozApps.runUpdate");
    Services.prefs.setBoolPref("dom.mozApps.runUpdate", false);

    // 1.
    this.loadCurrentRegistry((function() {
#ifdef MOZ_WIDGET_GONK
    // if first run, merge the system apps.
    if (runUpdate) {
      let file;
      try {
        file = FileUtils.getFile("coreAppsDir", ["webapps", "webapps.json"], false);
      } catch(e) { }

      if (file && file.exists) {
        // 2.a
        this._loadJSONAsync(file, (function loadCoreRegistry(aData) {
          if (!aData) {
            this.registerAppsHandlers();
            return;
          }

          // 2.b : core apps are not removable.
          for (let id in this.webapps) {
            if (id in aData || this.webapps[id].removable)
              continue;
            let localId = this.webapps[id].localId;
            delete this.webapps[id];
            // XXXX once bug 758269 is ready, revoke perms for this app
            // removePermissions(localId);
          }

          let appDir = FileUtils.getDir("coreAppsDir", ["webapps"], false);
          // 2.c
          for (let id in aData) {
            // Core apps have ids matching their domain name (eg: dialer.gaiamobile.org)
            // Use that property to check if they are new or not.
            if (!(id in this.webapps)) {
              this.webapps[id] = aData[id];
              this.webapps[id].basePath = appDir.path;

              // Create a new localId.
              this.webapps[id].localId = this._nextLocalId();

              // Core apps are not removable.
              if (this.webapps[id].removable === undefined) {
                this.webapps[id].removable = false;
              }
            }
            // XXXX once bug 758269 is ready, revoke perms for this app
            // let localId = this.webapps[id].localId;
            // installPermissions(localId);
          }
          this.registerAppsHandlers();
        }).bind(this));
      } else {
        this.registerAppsHandlers();
      }
    } else {
      this.registerAppsHandlers();
    }
#else
    this.registerAppsHandlers();
#endif
    }).bind(this));
  },

#ifdef MOZ_SYS_MSG

  // aEntryPoint is either the entry_point name or the null, in which case we
  // use the root of the manifest.
  _registerSystemMessagesForEntryPoint: function(aManifest, aApp, aEntryPoint) {
    let root = aManifest;
    if (aEntryPoint && aManifest.entry_points[aEntryPoint]) {
      root = aManifest.entry_points[aEntryPoint];
    }

    if (!root.messages || !Array.isArray(root.messages) ||
        root.messages.length == 0) {
      return;
    }

    let manifest = new DOMApplicationManifest(aManifest, aApp.origin);
    let launchPath = Services.io.newURI(manifest.fullLaunchPath(aEntryPoint), null, null);
    let manifestURL = Services.io.newURI(aApp.manifestURL, null, null);
    root.messages.forEach(function registerPages(aMessage) {
      let href = launchPath;
      let messageName;
      if (typeof(aMessage) === "object" && Object.keys(aMessage).length === 1) {
        messageName = Object.keys(aMessage)[0];
        href = Services.io.newURI(manifest.resolveFromOrigin(aMessage[messageName]), null, null);
      } else {
        messageName = aMessage;
      }
      msgmgr.registerPage(messageName, href, manifestURL);
    });
  },

  _registerSystemMessages: function(aManifest, aApp) {
    this._registerSystemMessagesForEntryPoint(aManifest, aApp, null);

    if (!aManifest.entry_points) {
      return;
    }

    for (let entryPoint in aManifest.entry_points) {
      this._registerSystemMessagesForEntryPoint(aManifest, aApp, entryPoint);
    }
  },

  // aEntryPoint is either the entry_point name or the null, in which case we
  // use the root of the manifest.
  _registerActivitiesForEntryPoint: function(aManifest, aApp, aEntryPoint) {
    let root = aManifest;
    if (aEntryPoint && aManifest.entry_points[aEntryPoint]) {
      root = aManifest.entry_points[aEntryPoint];
    }

    if (!root.activities) {
      return;
    }

    let manifest = new DOMApplicationManifest(aManifest, aApp.origin);
    for (let activity in root.activities) {
      let description = root.activities[activity];
      if (!description.href) {
        description.href = manifest.launch_path;
      }
      description.href = manifest.resolveFromOrigin(description.href);
      let json = {
        "manifest": aApp.manifestURL,
        "name": activity,
        "title": manifest.name,
        "icon": manifest.iconURLForSize(128),
        "description": description
      }
      this.activitiesToRegister++;
      cpmm.sendAsyncMessage("Activities:Register", json);

      let launchPath =
        Services.io.newURI(manifest.resolveFromOrigin(description.href), null, null);
      let manifestURL = Services.io.newURI(aApp.manifestURL, null, null);
      msgmgr.registerPage("activity", launchPath, manifestURL);
    }
  },

  _registerActivities: function(aManifest, aApp) {
    this._registerActivitiesForEntryPoint(aManifest, aApp, null);

    if (!aManifest.entry_points) {
      return;
    }

    for (let entryPoint in aManifest.entry_points) {
      this._registerActivitiesForEntryPoint(aManifest, aApp, entryPoint);
    }
  },

  _unregisterActivitiesForEntryPoint: function(aManifest, aApp, aEntryPoint) {
    let root = aManifest;
    if (aEntryPoint && aManifest.entry_points[aEntryPoint]) {
      root = aManifest.entry_points[aEntryPoint];
    }

    if (!root.activities) {
      return;
    }

    for (let activity in root.activities) {
      let description = root.activities[activity];
      let json = {
        "manifest": aApp.manifestURL,
        "name": activity
      }
      cpmm.sendAsyncMessage("Activities:Unregister", json);
    }
  },

  _unregisterActivities: function(aManifest, aApp) {
    this._unregisterActivitiesForEntryPoint(aManifest, aApp, null);

    if (!aManifest.entry_points) {
      return;
    }

    for (let entryPoint in aManifest.entry_points) {
      this._unregisterActivitiesForEntryPoint(aManifest, aApp, entryPoint);
    }
  },

  _processManifestForIds: function(aIds) {
    this.activitiesToRegister = 0;
    this.activitiesRegistered = 0;
    this.allActivitiesSent = false;
    this._readManifests(aIds, (function registerManifests(aResults) {
      aResults.forEach(function registerManifest(aResult) {
        let app = this.webapps[aResult.id];
        let manifest = aResult.manifest;
        app.name = manifest.name;
        this._registerSystemMessages(manifest, app);
        this._registerActivities(manifest, app);
      }, this);
      this.allActivitiesSent = true;
    }).bind(this));
  },
#endif

  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "xpcom-shutdown") {
      this.messages.forEach((function(msgName) {
        ppmm.removeMessageListener(msgName, this);
      }).bind(this));
      Services.obs.removeObserver(this, "xpcom-shutdown");
      ppmm = null;
    }
  },

  _loadJSONAsync: function(aFile, aCallback) {
    try {
      let channel = NetUtil.newChannel(aFile);
      channel.contentType = "application/json";
      NetUtil.asyncFetch(channel, function(aStream, aResult) {
        if (!Components.isSuccessCode(aResult)) {
          Cu.reportError("DOMApplicationRegistry: Could not read from json file "
                         + aFile.path);
          if (aCallback)
            aCallback(null);
          return;
        }

        // Read json file into a string
        let data = null;
        try {
          // Obtain a converter to read from a UTF-8 encoded input stream.
          let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                          .createInstance(Ci.nsIScriptableUnicodeConverter);
          converter.charset = "UTF-8";

          data = JSON.parse(converter.ConvertToUnicode(NetUtil.readInputStreamToString(aStream,
                                                            aStream.available()) || ""));
          aStream.close();
          if (aCallback)
            aCallback(data);
        } catch (ex) {
          Cu.reportError("DOMApplicationRegistry: Could not parse JSON: " +
                         aFile.path + " " + ex);
          if (aCallback)
            aCallback(null);
        }
      });
    } catch (ex) {
      Cu.reportError("DOMApplicationRegistry: Could not read from " +
                     aFile.path + " : " + ex);
      if (aCallback)
        aCallback(null);
    }
  },

  addMessageListener: function(aMsgNames, aMm) {
    aMsgNames.forEach(function (aMsgName) {
      if (!(aMsgName in this.children)) {
        this.children[aMsgName] = [];
      }
      this.children[aMsgName].push(aMm);
    }, this);
  },

  removeMessageListener: function(aMsgNames, aMm) {
    aMsgNames.forEach(function (aMsgName) {
      if (!(aMsgName in this.children)) {
        return;
      }

      let index;
      if ((index = this.children[aMsgName].indexOf(aMm)) != -1) {
        this.children[aMsgName].splice(index, 1);
      }
    }, this);
  },

  receiveMessage: function(aMessage) {
    // nsIPrefBranch throws if pref does not exist, faster to simply write
    // the pref instead of first checking if it is false.
    Services.prefs.setBoolPref("dom.mozApps.used", true);

    let msg = aMessage.json;
    let mm = aMessage.target;
    msg.mm = mm;

    switch (aMessage.name) {
      case "Webapps:Install":
        // always ask for UI to install
        Services.obs.notifyObservers(mm, "webapps-ask-install", JSON.stringify(msg));
        break;
      case "Webapps:GetSelf":
        this.getSelf(msg, mm);
        break;
      case "Webapps:Uninstall":
        this.uninstall(msg, mm);
        debug("Webapps:Uninstall");
        break;
      case "Webapps:Launch":
        this.launchApp(msg, mm);
        break;
      case "Webapps:IsInstalled":
        this.isInstalled(msg, mm);
        break;
      case "Webapps:GetInstalled":
        this.getInstalled(msg, mm);
        break;
      case "Webapps:GetNotInstalled":
        this.getNotInstalled(msg, mm);
        break;
      case "Webapps:GetAll":
        if (msg.hasPrivileges)
          this.getAll(msg, mm);
        else
          mm.sendAsyncMessage("Webapps:GetAll:Return:KO", msg);
        break;
      case "Webapps:InstallPackage":
        this.installPackage(msg, mm);
        break;
      case "Webapps:GetBasePath":
        return this.webapps[msg.id].basePath;
        break;
      case "Webapps:RegisterForMessages":
        this.addMessageListener(msg, mm);
        break;
      case "Webapps:UnregisterForMessages":
        this.removeMessageListener(msg, mm);
        break;
      case "Webapps:GetList":
        this.addMessageListener(["Webapps:AddApp", "Webapps:RemoveApp"], mm);
        return this.webapps;
      case "Webapps:CancelDownload":
        this.cancelDowload(msg.manifestURL);
        break;
      case "Webapps:CheckForUpdate":
        this.checkForUpdate(msg, mm);
        break;
      case "Activities:Register:OK":
        this.activitiesRegistered++;
        if (this.allActivitiesSent &&
            this.activitiesRegistered === this.activitiesToRegister) {
          this.onInitDone();
        }
        break;
    }
  },

  // Some messages can be listened by several content processes:
  // Webapps:AddApp
  // Webapps:RemoveApp
  // Webapps:Install:Return:OK
  // Webapps:Uninstall:Return:OK
  // Webapps:OfflineCache
  broadcastMessage: function broadcastMessage(aMsgName, aContent) {
    if (!(aMsgName in this.children)) {
      return;
    }
    let i;
    for (i = this.children[aMsgName].length - 1; i >= 0; i -= 1) {
      let msgMgr = this.children[aMsgName][i];
      try {
        msgMgr.sendAsyncMessage(aMsgName, aContent);
      } catch (e) {
        // Remove once 777508 lands.
        let index;
        if ((index = this.children[aMsgName].indexOf(msgMgr)) != -1) {
          this.children[aMsgName].splice(index, 1);
          dump("Remove dead MessageManager!\n");
        }
      }
    };
  },

  _getAppDir: function(aId) {
    return FileUtils.getDir(DIRECTORY_NAME, ["webapps", aId], true, true);
  },

  _writeFile: function ss_writeFile(aFile, aData, aCallbak) {
    // Initialize the file output stream.
    let ostream = FileUtils.openSafeFileOutputStream(aFile);

    // Obtain a converter to convert our data to a UTF-8 encoded input stream.
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                    .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";

    // Asynchronously copy the data to the file.
    let istream = converter.convertToInputStream(aData);
    NetUtil.asyncCopy(istream, ostream, function(rc) {
      if (aCallbak)
        aCallbak();
    });
  },

  launchApp: function launchApp(aData, aMm) {
    let app = this.getAppByManifestURL(aData.manifestURL);
    if (!app) {
      aMm.sendAsyncMessage("Webapps:Launch:Return:KO", aData);
      return;
    }

    // Fire an error when trying to launch an app that is not
    // yet fully installed.
    if (app.installState == "pending") {
      aMm.sendAsyncMessage("Webapps:Launch:Return:KO", aData);
      return;
    }

    Services.obs.notifyObservers(aMm, "webapps-launch", JSON.stringify(aData));
  },

  cancelDownload: function cancelDowload(aManifestURL) {
    // We can't cancel appcache dowloads for now.
    if (!this.downloads[aManifestURL]) {
      return;
    }
    // This is a HTTP channel.
    let download = this.downloads[aManifestURL]
    download.channel.cancel(Cr.NS_BINDING_ABORTED);
    let app = this.webapps[dowload.appId];

    app.progress = 0;
    app.installState = app.previousState;
    app.dowloading = false;
    app.dowloadavailable = false;
    app.downloadSize = 0;
    this._saveApps((function() {
      this.broadcastMessage("Webapps:PackageEvent",
                             { type: "canceled",
                               manifestURL:  aApp.manifestURL,
                               app: app,
                               error: "DOWNLOAD_CANCELED" });
    }).bind(this));
  },

  startOfflineCacheDownload: function startOfflineCacheDownload(aManifest, aApp, aProfileDir) {
    // if the manifest has an appcache_path property, use it to populate the appcache
    if (aManifest.appcache_path) {
      let appcacheURI = Services.io.newURI(aManifest.fullAppcachePath(), null, null);
      let updateService = Cc["@mozilla.org/offlinecacheupdate-service;1"]
                            .getService(Ci.nsIOfflineCacheUpdateService);
      let docURI = Services.io.newURI(aManifest.fullLaunchPath(), null, null);
      let cacheUpdate = aProfileDir ? updateService.scheduleCustomProfileUpdate(appcacheURI, docURI, aProfileDir)
                                    : updateService.scheduleUpdate(appcacheURI, docURI, null);
      cacheUpdate.addObserver(new AppcacheObserver(aApp), false);
      if (aOfflineCacheObserver) {
        cacheUpdate.addObserver(aOfflineCacheObserver, false);
      }
    }
  },

  /**
   * Install permissisions or remove deprecated permissions upon re-install
   * @param object aAppObject
   *        The just installed AppUtils cloned appObject
   * @param object aData
   *        The just-installed app configuration
   * @param boolean aIsReinstall
   *        Indicates the app was just re-installed
   * @returns void
   **/
  installPermissions:
  function installPermissions(aAppObject, aData, aIsReinstall)
  {
    try {
      let newManifest = new DOMApplicationManifest(aData.app.manifest,
                                                   aData.app.origin);
      if (!newManifest.permissions && !aIsReinstall) {
        return;
      }

      if (aIsReinstall) {
        // Compare the original permissions against the new permissions
        // Remove any deprecated Permissions

        if (newManifest.permissions) {
          // Expand perms
          let newPerms = [];
          for (let perm in newManifest.permissions) {
            let _perms = expandPermissions(perm,
                                           newManifest.permissions[perm].access);
            newPerms = newPerms.concat(_perms);
          }

          for (let idx in AllPossiblePermissions) {
            let index = newPerms.indexOf(AllPossiblePermissions[idx]);
            if (index == -1) {
              // See if the permission was installed previously
              let _perm = PermSettings.get(AllPossiblePermissions[idx],
                                           aData.app.manifestURL,
                                           aData.app.origin,
                                           false);
              if (_perm == "unknown" || _perm == "deny") {
                // All 'deny' permissions should be preserved
                continue;
              }
              // Remove the deprecated permission
              // TODO: use PermSettings.remove, see bug 793204
              PermSettings.set(AllPossiblePermissions[idx],
                               "unknown",
                               aData.app.manifestURL,
                               aData.app.origin,
                               false);
            }
          }
        }
      }

      let installPermType;
      // Check to see if the 'webapp' is app/priv/certified
      switch (getAppManifestStatus(newManifest)) {
      case Ci.nsIPrincipal.APP_STATUS_CERTIFIED:
        installPermType = "certified";
        break;
      case Ci.nsIPrincipal.APP_STATUS_PRIVILEGED:
        installPermType = "privileged";
        break;
      case Ci.nsIPrincipal.APP_STATUS_INSTALLED:
        installPermType = "app";
        break;
      default:
        // Cannot determine app type, abort install by throwing an error
        throw new Error("Webapps.jsm: Cannot determine app type, install cancelled");
      }

      for (let permName in newManifest.permissions) {
        if (!PermissionsTable[permName]) {
          throw new Error("Webapps.jsm: '" + permName + "'" +
                         " is not a valid Webapps permission type. Aborting Webapp installation");
          return;
        }

        let perms = expandPermissions(permName,
                                      newManifest.permissions[permName].access);
        for (let idx in perms) {
          let perm = PermissionsTable[permName][installPermType];
          let permValue = PERM_TO_STRING[perm];
          PermSettings.set(perms[idx],
                           permValue,
                           aData.app.manifestURL,
                           aData.app.origin,
                           false);
        }
      }
    }
    catch (ex) {
      debug("Caught webapps install permissions error");
      Cu.reportError(ex);
      this.uninstall(aData);
    }
   },

  checkForUpdate: function(aData, aMm) {
    let app = this.getAppByManifestURL(aData.manifestURL);
    if (!app) {
      aData.error = "NO_SUCH_APP";
      aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
      return;
    }

    function sendError(aError) {
      aData.error = aError;
      aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:KO", aData);
    }

    function updatePackagedApp(aManifest) {
      debug("updatePackagedApp");
    }

    function updateHostedApp(aManifest) {
      debug("updateHostedApp");
      let id = this._appId(app.origin);

#ifdef MOZ_SYS_MSG
      // Update the Web Activities
      this._readManifests([{ id: id }], (function unregisterManifest(aResult) {
        this._unregisterActivities(aResult[0].manifest, app);
        this._registerSystemMessages(aManifest, app);
        this._registerActivities(aManifest, app);
      }).bind(this));
#endif

      // Store the new manifest.
      let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
      let manFile = dir.clone();
      manFile.append("manifest.webapp");
      this._writeFile(manFile, JSON.stringify(aManifest), function() { });

      let manifest = new DOMApplicationManifest(aManifest, app.origin);

      if (manifest.appcache_path) {
        app.installState = "updating";
        app.downloadAvailable = true;
        app.downloading = true;
        app.downloadsize = 0;
        app.readyToApplyDownload = false;
      } else {
        app.installState = "installed";
        app.downloadAvailable = false;
        app.downloading = false;
        app.readyToApplyDownload = false;
      }

      app.name = aManifest.name;

      // Update the registry.
      this.webapps[id] = app;

      this._saveApps((function() {
        // XXX Should we fire notifications ?
      }).bind(this));

      // Preload the appcache if needed.
      this.startOfflineCacheDownload(manifest, app);
    }

    // First, we download the manifest.
    let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    xhr.open("GET", aData.manifestURL, true);
    if (aData.etag) {
      xhr.setRequestHeader("If-None-Match", aData.etag);
    }

    xhr.addEventListener("load", (function() {
      if (xhr.status == 200) {
        let manifest;
        try {
          JSON.parse(xhr.responseText, installOrigin);
        } catch(e) {
          sendError("MANIFEST_PARSE_ERROR");
          return;
        }
        if (!AppsUtils.checkManifest(manifest, installOrigin)) {
          sendError("INVALID_MANIFEST");
        } else {
          app.etag = xhr.getResponseHeader("Etag");
          app.lastCheckedUpdate = Date.now();
          if (package_path in manifest) {
            updatePackagedApp(manifest);
          } else {
            updateHostedApp(manifest);
          }
        }
        this._saveApps();
      } else if (xhr.status == 304) {
        // The manifest has not changed. We just update lastCheckedUpdate.
        app.lastCheckedUpdate = Date.now();
        aData.event = "downloadapplied";
        aData.app = {
          lastCheckedUpdate: app.lastCheckedUpdate
        }
        aMm.sendAsyncMessage("Webapps:CheckForUpdate:Return:OK", aData);
        this._saveApps();
      } else {
        sendError("MANIFEST_URL_ERROR");
      }
    }).bind(this), false);

    xhr.addEventListener("error", (function() {
      sendError(request, "NETWORK_ERROR");
    }).bind(this), false);

    xhr.send(null);
  },

  denyInstall: function(aData) {
    let packageId = aData.app.packageId;
    if (packageId) {
      let dir = FileUtils.getDir("TmpD", ["webapps", packageId],
                                 true, true);
      try {
        dir.remove(true);
      } catch(e) {
      }
    }
    aData.mm.sendAsyncMessage("Webapps:Install:Return:KO", aData);
  },

  confirmInstall: function(aData, aFromSync, aProfileDir, aOfflineCacheObserver) {
    let isReinstall = false;
    let app = aData.app;
    app.removable = true;

    let origin = Services.io.newURI(app.origin, null, null);
    let manifestURL = origin.resolve(app.manifestURL);

    let id = app.syncId || this._appId(app.origin);
    let localId = this.getAppLocalIdByManifestURL(manifestURL);

    // Installing an application again is considered as an update.
    if (id) {
      isReinstall = true;
      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch(e) {
      }
    } else {
      id = this.makeAppId();
      app.id = id;
      localId = this._nextLocalId();
    }

    let manifestName = "manifest.webapp";
    if (aData.isPackage) {
      // Override the origin with the correct id.
      app.origin = "app://" + id;

      // For packaged apps, keep the update manifest distinct from the app
      // manifest.
      manifestName = "update.webapp";
    }

    let appObject = AppsUtils.cloneAppObject(app);
    appObject.appStatus = app.appStatus || Ci.nsIPrincipal.APP_STATUS_INSTALLED;
    appObject.installTime = app.installTime = Date.now();
    appObject.lastUpdateCheck = app.lastUpdateCheck = Date.now();
    let appNote = JSON.stringify(appObject);
    appNote.id = id;

    appObject.localId = localId;
    appObject.basePath = FileUtils.getDir(DIRECTORY_NAME, ["webapps"], true, true).path;
    let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
    let manFile = dir.clone();
    manFile.append(manifestName);
    let jsonManifest = aData.isPackage ? app.updateManifest : app.manifest;
    this._writeFile(manFile, JSON.stringify(jsonManifest), function() { });

    let manifest = new DOMApplicationManifest(jsonManifest, app.origin);

    if (manifest.appcache_path) {
      appObject.installState = "pending";
      appObject.downloadAvailable = true;
      appObject.downloading = true;
      appObject.downloadSize = 0;
      appObject.readyToApplyDownload = false;
    } else if (manifest.package_path) {
      appObject.installState = "pending";
      appObject.downloadAvailable = true;
      appObject.downloading = true;
      appObject.downloadSize = manifest.size;
      appObject.readyToApplyDownload = false;
    } else {
      appObject.installState = "installed";
      appObject.downloadAvailable = false;
      appObject.downloading = false;
      appObject.readyToApplyDownload = false;
    }

    appObject.name = manifest.name;

    this.webapps[id] = appObject;
    this.installPermissions(appObject, aData, isReinstall);
    ["installState", "downloadAvailable",
     "downloading", "downloadSize", "readyToApplyDownload"].forEach(function(aProp) {
      aData.app[aProp] = appObject[aProp];
     });

    if (!aFromSync)
      this._saveApps((function() {
        this.broadcastMessage("Webapps:Install:Return:OK", aData);
        Services.obs.notifyObservers(this, "webapps-sync-install", appNote);
        this.broadcastMessage("Webapps:AddApp", { id: id, app: appObject });
      }).bind(this));

#ifdef MOZ_SYS_MSG
    if (!aData.isPackage) {
      this._registerSystemMessages(app.manifest, app);
      this._registerActivities(app.manifest, app);
    }
#endif

    this.startOfflineCacheDownload(manifest, appObject, aProfileDir);
    if (manifest.package_path) {
      this.downloadPackage(manifest, appObject);
    }
  },

  _nextLocalId: function() {
    let id = Services.prefs.getIntPref("dom.mozApps.maxLocalId") + 1;
    Services.prefs.setIntPref("dom.mozApps.maxLocalId", id);
    return id;
  },

  _appId: function(aURI) {
    for (let id in this.webapps) {
      if (this.webapps[id].origin == aURI)
        return id;
    }
    return null;
  },

  _appIdForManifestURL: function(aURI) {
    for (let id in this.webapps) {
      if (this.webapps[id].manifestURL == aURI)
        return id;
    }
    return null;
  },

  makeAppId: function() {
    let uuidGenerator = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
    return uuidGenerator.generateUUID().toString();
  },

  _saveApps: function(aCallback) {
    this._writeFile(this.appsFile, JSON.stringify(this.webapps, null, 2), function() {
      if (aCallback)
        aCallback();
    });
  },

  /**
    * Asynchronously reads a list of manifests
    */
  _readManifests: function(aData, aFinalCallback, aIndex) {
    if (!aData.length) {
      aFinalCallback(aData);
      return;
    }

    let index = aIndex || 0;
    let id = aData[index].id;

    // the manifest file used to be named manifest.json, so fallback on this.
    let baseDir = (this.webapps[id].removable ? DIRECTORY_NAME : "coreAppsDir");
    let file = FileUtils.getFile(baseDir, ["webapps", id, "manifest.webapp"], true);
    if (!file.exists()) {
      file = FileUtils.getFile(baseDir, ["webapps", id, "update.webapp"], true);
    }
    if (!file.exists()) {
      file = FileUtils.getFile(baseDir, ["webapps", id, "manifest.json"], true);
    }

    this._loadJSONAsync(file, (function(aJSON) {
      aData[index].manifest = aJSON;
      if (index == aData.length - 1)
        aFinalCallback(aData);
      else
        this._readManifests(aData, aFinalCallback, index + 1);
    }).bind(this));
  },

  downloadPackage: function(aManifest, aApp) {
    // Here are the steps when installing a package:
    // - create a temp directory where to store the app.
    // - download the zip in this directory.
    // - extract the manifest from the zip and check it.
    // - ask confirmation to the user.
    // - add the new app to the registry.
    // If we fail at any step, we backout the previous ones and return an error.

    debug(JSON.stringify(aApp));

    let id = this._appIdForManifestURL(aApp.manifestURL);
    let app = this.webapps[id];

    // Removes the directory we created, and sends an error to the DOM side.
    function cleanup(aError) {
      debug("Cleanup: " + aError);
      let dir = FileUtils.getDir("TmpD", ["webapps", id], true, true);
      try {
        dir.remove(true);
      } catch (e) { }
        this.broadcastMessage("Webapps:PackageEvent",
                              { type: "error",
                                manifestURL:  aApp.manifestURL,
                                error: aError});
    }

    function getInferedStatus() {
      // XXX Update once we have digital signatures (bug 772365)
      return Ci.nsIPrincipal.APP_STATUS_INSTALLED;
    }

    function getAppStatus(aManifest) {
      let manifestStatus = getAppManifestStatus(aManifest);
      let inferedStatus = getInferedStatus();

      return (Services.prefs.getBoolPref("dom.mozApps.dev_mode") ? manifestStatus
                                                                : inferedStatus);
    }
    // Returns true if the privilege level from the manifest
    // is lower or equal to the one we infered for the app.
    function checkAppStatus(aManifest) {
      if (Services.prefs.getBoolPref("dom.mozApps.dev_mode")) {
        return true;
      }

      return (getAppManifestStatus(aManifest) <= getInferedStatus());
    }

    debug("About to download " + aManifest.fullPackagePath());

    let requestChannel = NetUtil.newChannel(aManifest.fullPackagePath())
                                .QueryInterface(Ci.nsIHttpChannel);
    this.downloads[aApp.manifestURL] =
      { channel:requestChannel,
        appId: id,
        previousState: "pending"
      };
    requestChannel.notificationCallbacks = {
      QueryInterface: function notifQI(aIID) {
        if (aIID.equals(Ci.nsISupports)          ||
            aIID.equals(Ci.nsIProgressEventSink))
          return this;

        throw Cr.NS_ERROR_NO_INTERFACE;
      },
      getInterface: function notifGI(aIID) {
        return this.QueryInterface(aIID);
      },
      onProgress: function notifProgress(aRequest, aContext,
                                         aProgress, aProgressMax) {
        debug("onProgress: " + aProgress + "/" + aProgressMax);
        app.progress = aProgress;
        DOMApplicationRegistry.broadcastMessage("Webapps:PackageEvent",
                                                { type: "progress",
                                                  manifestURL: aApp.manifestURL,
                                                  progress: aProgress });
      },
      onStatus: function notifStatus(aRequest, aContext, aStatus, aStatusArg) { }
    }

    NetUtil.asyncFetch(requestChannel,
    function(aInput, aResult, aRequest) {
      if (!Components.isSuccessCode(aResult)) {
        // We failed to fetch the zip.
        cleanup("NETWORK_ERROR");
        return;
      }
      // Copy the zip on disk.
      let zipFile = FileUtils.getFile("TmpD",
                                      ["webapps", id, "application.zip"], true);
      let ostream = FileUtils.openSafeFileOutputStream(zipFile);
      NetUtil.asyncCopy(aInput, ostream, function (aResult) {
        if (!Components.isSuccessCode(aResult)) {
          // We failed to save the zip.
          cleanup("DOWNLOAD_ERROR");
          return;
        }

        let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"]
                        .createInstance(Ci.nsIZipReader);
        try {
          zipReader.open(zipFile);
          if (!zipReader.hasEntry("manifest.webapp")) {
            throw "No manifest.webapp found.";
          }

          let istream = zipReader.getInputStream("manifest.webapp");

          // Obtain a converter to read from a UTF-8 encoded input stream.
          let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                          .createInstance(Ci.nsIScriptableUnicodeConverter);
          converter.charset = "UTF-8";

          let manifest = JSON.parse(converter.ConvertToUnicode(NetUtil.readInputStreamToString(istream,
                                                               istream.available()) || ""));

          if (!AppsUtils.checkManifest(manifest, aApp.installOrigin)) {
            throw "INVALID_MANIFEST";
          }

          if (!checkAppStatus(manifest)) {
            throw "INVALID_SECURITY_LEVEL";
          }

          // Success! Move the zip out of TmpD.
          let dir = FileUtils.getDir(DIRECTORY_NAME, ["webapps", id], true, true);
          zipFile.moveTo(dir, "application.zip");
          let tmpDir = FileUtils.getDir("TmpD", ["webapps", id], true, true);
          try {
            tmpDir.remove(true);
          } catch(e) { }

          // Save the manifest
          let manFile = dir.clone();
          manFile.append("manifest.webapp");
          DOMApplicationRegistry._writeFile(manFile,
                                            JSON.stringify(manifest),
                                            function() { });
          // Set state and fire events.
          app.installState = "installed";
          app.dowloading = false;
          app.dowloadavailable = false;
          DOMApplicationRegistry._saveApps(function() {
            debug("About to fire Webapps:PackageEvent");
            DOMApplicationRegistry.broadcastMessage("Webapps:PackageEvent",
                                                    { type: "installed",
                                                      manifestURL: aApp.manifestURL,
                                                      app: app,
                                                      manifest: manifest });
            delete DOMApplicationRegistry.downloads[aApp.manifestURL]
          });
        } catch (e) {
          // XXX we may need new error messages.
          cleanup(e);
        } finally {
          zipReader.close();
        }
      });
    });
  },

  uninstall: function(aData, aMm) {
    for (let id in this.webapps) {
      let app = this.webapps[id];
      if (app.origin != aData.origin) {
        continue;
      }

      if (!this.webapps[id].removable)
        return;

      // Clear private data first.
      this._clearPrivateData(app.localId, false);

      // Then notify observers.
      Services.obs.notifyObservers(aMm, "webapps-uninstall", JSON.stringify(aData));

      let appNote = JSON.stringify(AppsUtils.cloneAppObject(app));
      appNote.id = id;

#ifdef MOZ_SYS_MSG
      this._readManifests([{ id: id }], (function unregisterManifest(aResult) {
        this._unregisterActivities(aResult[0].manifest, app);
      }).bind(this));
#endif

      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch (e) {}

      delete this.webapps[id];

      this._saveApps((function() {
        this.broadcastMessage("Webapps:Uninstall:Return:OK", aData);
        Services.obs.notifyObservers(this, "webapps-sync-uninstall", appNote);
        this.broadcastMessage("Webapps:RemoveApp", { id: id });
      }).bind(this));

      return;
    }

    aMm.sendAsyncMessage("Webapps:Uninstall:Return:KO", aData);
  },

  getSelf: function(aData, aMm) {
    aData.apps = [];

    if (aData.appId == Ci.nsIScriptSecurityManager.NO_APP_ID ||
        aData.appId == Ci.nsIScriptSecurityManager.UNKNOWN_APP_ID) {
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
      return;
    }

    let tmp = [];

    for (let id in this.webapps) {
      if (this.webapps[id].origin == aData.origin &&
          this.webapps[id].localId == aData.appId &&
          this._isLaunchable(this.webapps[id].origin)) {
        let app = AppsUtils.cloneAppObject(this.webapps[id]);
        aData.apps.push(app);
        tmp.push({ id: id });
        break;
      }
    }

    if (!aData.apps.length) {
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
      return;
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetSelf:Return:OK", aData);
    }).bind(this));
  },

  isInstalled: function(aData, aMm) {
    aData.installed = false;

    for (let appId in this.webapps) {
      if (this.webapps[appId].manifestURL == aData.manifestURL) {
        aData.installed = true;
        break;
      }
    }

    aMm.sendAsyncMessage("Webapps:IsInstalled:Return:OK", aData);
  },

  getInstalled: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      if (this.webapps[id].installOrigin == aData.origin &&
          this._isLaunchable(this.webapps[id].origin)) {
        aData.apps.push(AppsUtils.cloneAppObject(this.webapps[id]));
        tmp.push({ id: id });
      }
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetInstalled:Return:OK", aData);
    }).bind(this));
  },

  getNotInstalled: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      if (!this._isLaunchable(this.webapps[id].origin)) {
        aData.apps.push(AppsUtils.cloneAppObject(this.webapps[id]));
        tmp.push({ id: id });
      }
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetNotInstalled:Return:OK", aData);
    }).bind(this));
  },

  getAll: function(aData, aMm) {
    aData.apps = [];
    let tmp = [];

    for (let id in this.webapps) {
      let app = AppsUtils.cloneAppObject(this.webapps[id]);
      if (!this._isLaunchable(app.origin))
        continue;

      aData.apps.push(app);
      tmp.push({ id: id });
    }

    this._readManifests(tmp, (function(aResult) {
      for (let i = 0; i < aResult.length; i++)
        aData.apps[i].manifest = aResult[i].manifest;
      aMm.sendAsyncMessage("Webapps:GetAll:Return:OK", aData);
    }).bind(this));
  },

  getManifestFor: function(aOrigin, aCallback) {
    if (!aCallback)
      return;

    let id = this._appId(aOrigin);
    if (!id || this.webapps[id].installState == "pending") {
      aCallback(null);
      return;
    }

    this._readManifests([{ id: id }], function(aResult) {
      aCallback(aResult[0].manifest);
    });
  },

  /** Added to support AITC and classic sync */
  itemExists: function(aId) {
    return !!this.webapps[aId];
  },

  getAppById: function(aId) {
    if (!this.webapps[aId])
      return null;

    let app = AppsUtils.cloneAppObject(this.webapps[aId]);
    return app;
  },

  getAppByManifestURL: function(aManifestURL) {
    return AppsUtils.getAppByManifestURL(this.webapps, aManifestURL);
  },

  getAppByLocalId: function(aLocalId) {
    return AppsUtils.getAppByLocalId(this.webapps, aLocalId);
  },

  getManifestURLByLocalId: function(aLocalId) {
    return AppsUtils.getManifestURLByLocalId(this.webapps, aLocalId);
  },

  getAppLocalIdByManifestURL: function(aManifestURL) {
    return AppsUtils.getAppLocalIdByManifestURL(this.webapps, aManifestURL);
  },

  getAppFromObserverMessage: function(aMessage) {
    return AppsUtils.getAppFromObserverMessage(this.webapps, aMessage);
  },

  getAllWithoutManifests: function(aCallback) {
    let result = {};
    for (let id in this.webapps) {
      let app = AppsUtils.cloneAppObject(this.webapps[id]);
      result[id] = app;
    }
    aCallback(result);
  },

  updateApps: function(aRecords, aCallback) {
    for (let i = 0; i < aRecords.length; i++) {
      let record = aRecords[i];
      if (record.hidden) {
        if (!this.webapps[record.id] || !this.webapps[record.id].removable)
          continue;

        let origin = this.webapps[record.id].origin;
        delete this.webapps[record.id];
        let dir = this._getAppDir(record.id);
        try {
          dir.remove(true);
        } catch (e) {
        }
        this.broadcastMessage("Webapps:Uninstall:Return:OK", { origin: origin });
      } else {
        if (this.webapps[record.id]) {
          this.webapps[record.id] = record.value;
          delete this.webapps[record.id].manifest;
        } else {
          let data = { app: record.value };
          this.confirmInstall(data, true);
          this.broadcastMessage("Webapps:Install:Return:OK", data);
        }
      }
    }
    this._saveApps(aCallback);
  },

  getAllIDs: function() {
    let apps = {};
    for (let id in this.webapps) {
      // only sync http and https apps
      if (this.webapps[id].origin.indexOf("http") == 0)
        apps[id] = true;
    }
    return apps;
  },

  wipe: function(aCallback) {
    let ids = this.getAllIDs();
    for (let id in ids) {
      if (!this.webapps[id].removable) {
        continue;
      }

      delete this.webapps[id];
      let dir = this._getAppDir(id);
      try {
        dir.remove(true);
      } catch (e) {
      }
    }
    this._saveApps(aCallback);
  },

  _isLaunchable: function(aOrigin) {
    if (this.allAppsLaunchable)
      return true;

#ifdef XP_WIN
    let uninstallKey = Cc["@mozilla.org/windows-registry-key;1"]
                         .createInstance(Ci.nsIWindowsRegKey);
    try {
      uninstallKey.open(uninstallKey.ROOT_KEY_CURRENT_USER,
                        "SOFTWARE\\Microsoft\\Windows\\" +
                        "CurrentVersion\\Uninstall\\" +
                        aOrigin,
                        uninstallKey.ACCESS_READ);
      uninstallKey.close();
      return true;
    } catch (ex) {
      return false;
    }
#elifdef XP_MACOSX
    let mwaUtils = Cc["@mozilla.org/widget/mac-web-app-utils;1"]
                     .createInstance(Ci.nsIMacWebAppUtils);

    return !!mwaUtils.pathForAppWithIdentifier(aOrigin);
#elifdef XP_UNIX
    let env = Cc["@mozilla.org/process/environment;1"]
                .getService(Ci.nsIEnvironment);
    let xdg_data_home_env = env.get("XDG_DATA_HOME");

    let desktopINI;
    if (xdg_data_home_env != "") {
      desktopINI = Cc["@mozilla.org/file/local;1"]
                     .createInstance(Ci.nsIFile);
      desktopINI.initWithPath(xdg_data_home_env);
    }
    else {
      desktopINI = Services.dirsvc.get("Home", Ci.nsIFile);
      desktopINI.append(".local");
      desktopINI.append("share");
    }
    desktopINI.append("applications");

    let origin = Services.io.newURI(aOrigin, null, null);
    let uniqueName = origin.scheme + ";" +
                     origin.host +
                     (origin.port != -1 ? ";" + origin.port : "");

    desktopINI.append("owa-" + uniqueName + ".desktop");

    return desktopINI.exists();
#else
    return true;
#endif

  },

  _notifyCategoryAndObservers: function(subject, topic, data) {
    const serviceMarker = "service,";

    // First create observers from the category manager.
    let cm =
      Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
    let enumerator = cm.enumerateCategory(topic);

    let observers = [];

    while (enumerator.hasMoreElements()) {
      let entry =
        enumerator.getNext().QueryInterface(Ci.nsISupportsCString).data;
      let contractID = cm.getCategoryEntry(topic, entry);

      let factoryFunction;
      if (contractID.substring(0, serviceMarker.length) == serviceMarker) {
        contractID = contractID.substring(serviceMarker.length);
        factoryFunction = "getService";
      }
      else {
        factoryFunction = "createInstance";
      }

      try {
        let handler = Cc[contractID][factoryFunction]();
        if (handler) {
          let observer = handler.QueryInterface(Ci.nsIObserver);
          observers.push(observer);
        }
      } catch(e) { }
    }

    // Next enumerate the registered observers.
    enumerator = Services.obs.enumerateObservers(topic);
    while (enumerator.hasMoreElements()) {
      try {
        let observer = enumerator.getNext().QueryInterface(Ci.nsIObserver);
        if (observers.indexOf(observer) == -1) {
          observers.push(observer);
        }
      } catch (e) { }
    }

    observers.forEach(function (observer) {
      try {
        observer.observe(subject, topic, data);
      } catch(e) { }
    });
  },

  registerBrowserElementParentForApp: function(bep, appId) {
    let mm = bep._mm;

    // Make a listener function that holds on to this appId.
    let listener = this.receiveAppMessage.bind(this, appId);

    this.frameMessages.forEach(function(msgName) {
      mm.addMessageListener(msgName, listener);
    });
  },

  receiveAppMessage: function(appId, message) {
    switch (message.name) {
      case "Webapps:ClearBrowserData":
        this._clearPrivateData(appId, true);
        break;
    }
  },

  _clearPrivateData: function(appId, browserOnly) {
    let subject = {
      appId: appId,
      browserOnly: browserOnly,
      QueryInterface: XPCOMUtils.generateQI([Ci.mozIApplicationClearPrivateDataParams])
    };
    this._notifyCategoryAndObservers(subject, "webapps-clear-data", null);
  }
};

/**
 * Appcache download observer
 */
let AppcacheObserver = function(aApp) {
  this.app = aApp;
  this.startStatus = aApp.installState;
};

AppcacheObserver.prototype = {
  // nsIOfflineCacheUpdateObserver implementation
  updateStateChanged: function appObs_Update(aUpdate, aState) {
    let mustSave = false;
    let app = this.app;

    let setStatus = function appObs_setStatus(aStatus) {
      mustSave = (app.installState != aStatus);
      app.installState = aStatus;
      DOMApplicationRegistry.broadcastMessage("Webapps:OfflineCache",
                                              { manifest: app.manifestURL,
                                                installState: app.installState });
    }

    let setError = function appObs_setError(aError) {
      DOMApplicationRegistry.broadcastMessage("Webapps:OfflineCache",
                                              { manifest: app.manifestURL,
                                                error: aError });
    }

    switch (aState) {
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ERROR:
        aUpdate.removeObserver(this);
        setError("APP_CACHE_DOWNLOAD_ERROR");
        break;
      case Ci.nsIOfflineCacheUpdateObserver.STATE_NOUPDATE:
      case Ci.nsIOfflineCacheUpdateObserver.STATE_FINISHED:
        aUpdate.removeObserver(this);
        setStatus("installed");
        break;
      case Ci.nsIOfflineCacheUpdateObserver.STATE_DOWNLOADING:
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ITEMSTARTED:
      case Ci.nsIOfflineCacheUpdateObserver.STATE_ITEMPROGRESS:
        setStatus(this.startStatus);
        break;
    }

    // Status changed, update the stored version.
    if (mustSave) {
      DOMApplicationRegistry._saveApps();
    }
  },

  applicationCacheAvailable: function appObs_CacheAvail(aApplicationCache) {
    // Nothing to do.
  }
};

/**
 * Helper object to access manifest information with locale support
 */
let DOMApplicationManifest = function(aManifest, aOrigin) {
  this._origin = Services.io.newURI(aOrigin, null, null);
  this._manifest = aManifest;
  let chrome = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIXULChromeRegistry)
                                                          .QueryInterface(Ci.nsIToolkitChromeRegistry);
  let locale = chrome.getSelectedLocale("browser").toLowerCase();
  this._localeRoot = this._manifest;

  if (this._manifest.locales && this._manifest.locales[locale]) {
    this._localeRoot = this._manifest.locales[locale];
  }
  else if (this._manifest.locales) {
    // try with the language part of the locale ("en" for en-GB) only
    let lang = locale.split('-')[0];
    if (lang != locale && this._manifest.locales[lang])
      this._localeRoot = this._manifest.locales[lang];
  }
};

DOMApplicationManifest.prototype = {
  _localeProp: function(aProp) {
    if (this._localeRoot[aProp] != undefined)
      return this._localeRoot[aProp];
    return this._manifest[aProp];
  },

  get name() {
    return this._localeProp("name");
  },

  get description() {
    return this._localeProp("description");
  },

  get version() {
    return this._localeProp("version");
  },

  get launch_path() {
    return this._localeProp("launch_path");
  },

  get developer() {
    return this._localeProp("developer");
  },

  get icons() {
    return this._localeProp("icons");
  },

  get appcache_path() {
    return this._localeProp("appcache_path");
  },

  get orientation() {
    return this._localeProp("orientation");
  },

  get package_path() {
    return this._localeProp("package_path");
  },

  get size() {
    return this._manifest["size"] || 0;
  },

  get permissions() {
    if (this._manifest.permissions) {
      return this._manifest.permissions;
    }
    return {};
  },

  iconURLForSize: function(aSize) {
    let icons = this._localeProp("icons");
    if (!icons)
      return null;
    let dist = 100000;
    let icon = null;
    for (let size in icons) {
      let iSize = parseInt(size);
      if (Math.abs(iSize - aSize) < dist) {
        icon = this._origin.resolve(icons[size]);
        dist = Math.abs(iSize - aSize);
      }
    }
    return icon;
  },

  fullLaunchPath: function(aStartPoint) {
    // If no start point is specified, we use the root launch path.
    // In all error cases, we just return null.
    if ((aStartPoint || "") === "") {
      return this._origin.resolve(this._localeProp("launch_path") || "");
    }

    // Search for the l10n entry_points property.
    let entryPoints = this._localeProp("entry_points");
    if (!entryPoints) {
      return null;
    }

    if (entryPoints[aStartPoint]) {
      return this._origin.resolve(entryPoints[aStartPoint].launch_path || "");
    }

    return null;
  },

  resolveFromOrigin: function(aURI) {
    return this._origin.resolve(aURI);
  },

  fullAppcachePath: function() {
    let appcachePath = this._localeProp("appcache_path");
    return this._origin.resolve(appcachePath ? appcachePath : "");
  },

  fullPackagePath: function() {
    let packagePath = this._localeProp("package_path");
    return this._origin.resolve(packagePath ? packagePath : "");
  }
};

DOMApplicationRegistry.init();
