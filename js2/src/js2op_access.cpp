/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
*
* The contents of this file are subject to the Netscape Public
* License Version 1.1 (the "License"); you may not use this file
* except in compliance with the License. You may obtain a copy of
* the License at http://www.mozilla.org/NPL/
*
* Software distributed under the License is distributed on an "AS
* IS" basis, WITHOUT WARRANTY OF ANY KIND, either express or
* implied. See the License for the specific language governing
* rights and limitations under the License.
*
* The Original Code is the JavaScript 2 Prototype.
*
* The Initial Developer of the Original Code is Netscape
* Communications Corporation.   Portions created by Netscape are
* Copyright (C) 1998 Netscape Communications Corporation. All
* Rights Reserved.
*
* Contributor(s):
*
* Alternatively, the contents of this file may be used under the
* terms of the GNU Public License (the "GPL"), in which case the
* provisions of the GPL are applicable instead of those above.
* If you wish to allow use of your version of this file only
* under the terms of the GPL and not to allow others to use your
* version of this file under the NPL, indicate your decision by
* deleting the provisions above and replace them with the notice
* and other provisions required by the GPL.  If you do not delete
* the provisions above, a recipient may use your version of this
* file under either the NPL or the GPL.
*/

    // Get a multiname literal and push the resulting multiname object
    case eMultiname: 
        {
            push(OBJECT_TO_JS2VAL(mn));
        }
        break;

    case eDotRead:
        {
            Multiname *mn = bCon->mMultinameList[BytecodeContainer::getShort(pc)];
            pc += sizeof(short);
            js2val baseVal = pop();
            readProperty
        }
        break;

    // Pop a multiname object and read it's value from the environment on to the stack.
    case eLexicalRead: 
        {
            Multiname *mn = bCon->mMultinameList[BytecodeContainer::getShort(pc)];
            pc += sizeof(short);
            retval = meta->env.lexicalRead(meta, mn, phase);
            push(retval);
	}
        break;

    // Pop a value and a multiname. Write the value to the multiname in the environment, leave
    // the value on the stack top.
    case eLexicalWrite: 
        {
            Multiname *mn = bCon->mMultinameList[BytecodeContainer::getShort(pc)];
            pc += sizeof(short);
            meta->env.lexicalWrite(meta, mn, retval, true, phase);
            push(retval);
	}
        break;

    case ePushFrame: 
        {
            Frame *f = bCon->mFrameList[BytecodeContainer::getShort(pc)];
            pc += sizeof(short);
            meta->env.addFrame(f);
        }
        break;

    case ePopFrame: 
        {
            meta->env.removeTopFrame();
        }
        break;
