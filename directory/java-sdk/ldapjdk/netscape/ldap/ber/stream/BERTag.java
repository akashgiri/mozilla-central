/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public License
 * Version 1.0 (the "NPL"); you may not use this file except in
 * compliance with the NPL.  You may obtain a copy of the NPL at
 * http://www.mozilla.org/NPL/
 *
 * Software distributed under the NPL is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the NPL
 * for the specific language governing rights and limitations under the
 * NPL.
 *
 * The Initial Developer of this code under the NPL is Netscape
 * Communications Corporation.  Portions created by Netscape are
 * Copyright (C) 1998 Netscape Communications Corporation.  All Rights
 * Reserved.
 */
package netscape.ldap.ber.stream;

import java.util.*;
import java.io.*;

/**
 * This class is for the tagged object. Nested tag is
 * allowed. A tagged element contains another
 * ber element.
 *
 * @version 1.0
 * @seeAlso CCITT X.209
 */
public class BERTag extends BERElement {
    /**
     * Internal variables
     */
    private int m_tag = 0;
    private BERElement m_element = null;
    private boolean m_implicit = false;

    /**
     * Constructs a tag element.
     * @param tag tag value
     * @param element ber element
     * @param implicit tagged implicitly
     */
    public BERTag(int tag, BERElement element, boolean implicit) {
        m_tag = tag;
        m_element = element;
        m_implicit = implicit;
    }

    /**
     * Constructs a tag element with the input stream.
     * @param decoder decoder object for application specific tags
     * @param tag tag value; already stripped from stream
     * @param stream input stream
     * @param bytes_read array of 1 int; incremented by number
     *        ofbytes read from stream
     * @exception IOException failed to construct
     */
    public BERTag(BERTagDecoder decoder, int tag, InputStream stream,
        int[] bytes_read) throws IOException {

        m_tag = tag;
        boolean[] implicit = new boolean[1];

        /*
         * Need to use user callback to decode contents of
         * a non-universal tagged value.
         */
        m_element = decoder.getElement(decoder, tag, stream, bytes_read,
                      implicit);
        m_implicit = implicit[0];
    }

    /**
     * Gets the element from the tagged object.
     * @return ber element
     */
    public BERElement getValue() {
        return m_element;
    }

    /**
     * Sets implicit tag. If it is a implicit tag
     * the next element tag can be omitted. (will
     * not be send to stream or buffer)
     * @param value implicit flag
     */
    public void setImplicit(boolean value) {
        m_implicit = value;
    }

    /**
     * Sends the BER encoding directly to stream.
     * @param stream output stream
     * @exception IOException failed to send
     */
    public void write(OutputStream stream) throws IOException {
        stream.write(m_tag);  /* bcm - assuming tag is one byte */

        ByteArrayOutputStream contents_stream = new ByteArrayOutputStream();
        m_element.write(contents_stream);
        byte[] contents_buffer = contents_stream.toByteArray();

        if (m_implicit) {
            /* Assumes tag is only one byte.  Rest of buffer is */
            /* length and contents of tagged element.           */
            stream.write(contents_buffer, 1, contents_buffer.length -1);
        } else {
            /* Send length */
            sendDefiniteLength(stream, contents_buffer.length);
            /* Send contents */
            stream.write(contents_buffer);
        }
    }

    /**
     * Gets the element type.
     * @return element type
     */
    public int getType() {
        return BERElement.TAG;
    }

    /**
     * Gets the element tag.
     * @return element tag.
     */
    public int getTag() {
        return m_tag;
    }

    /**
     * Gets the string representation.
     * @return string representation of tag
     */
    public String toString() {
        String s = "";
        if ((m_tag & 0xC0) == 0)
            /* bits 8 + 7 are zeros */
            s = s + "UNIVERSAL-";
        else if (((m_tag & 0x80) & (m_tag & 0x40)) > 0)
            /* bits 8 + 7 are ones */
            s = s + "PRIVATE-";
        else if ((m_tag & 0x40) > 0)
            /* bit 8 is zero, bit 7 is one */
            s = s + "APPLICATION-";
        else if ((m_tag & 0x80) > 0)
            /* bit 8 is one, bit 7 is zero */
            s = s + "CONTEXT-";
        return "[" + s + (m_tag&0x1f) + "] " + m_element.toString();
    }
}
