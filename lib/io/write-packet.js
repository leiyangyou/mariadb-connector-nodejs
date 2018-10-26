"use strict";

const Iconv = require("iconv-lite");

const QUOTE = 0x27;
const DBL_QUOTE = 0x22;
const ZERO_BYTE = 0x00;
const SLASH = 0x5c;

const SMALL_BUFFER_SIZE = 1024;
const MEDIUM_BUFFER_SIZE = 16384; //16k
const LARGE_BUFFER_SIZE = 131072; //128k
const BIG_BUFFER_SIZE = 1048576; //1M
const MAX_BUFFER_SIZE = 16777219; //16M + 4

const CHARS_GLOBAL_REGEXP = /[\0\"\'\\]/g; // eslint-disable-line no-control-regex

/**
 * Object to easily store buffer.
 *
 */
class WritePacket {
  constructor(maxAllowedPacket, out, initString, endString) {
    this.out = out;
    this.buf = Buffer.allocUnsafe(SMALL_BUFFER_SIZE);
    this.pos = 4;
    this.initStr = initString;
    this.endStr = endString;
    this.encoding = out.encoding;
    this.endStrLength = Buffer.byteLength(1 + this.initStr + this.endStr, this.encoding);
    this.packetSend = 0;
    this.singleQuery = false;
    this.haveErrorResponse = false;

    if (this.encoding === "utf8") {
      this.writeString = this.writeDefaultBufferString;
      this.writeStringEscapeQuote = this.writeUtf8StringEscapeQuote;
    } else if (Buffer.isEncoding(this.encoding)) {
      this.writeString = this.writeDefaultBufferString;
      this.writeStringEscapeQuote = this.writeDefaultStringEscapeQuote;
    } else {
      this.writeString = this.writeDefaultIconvString;
      this.writeStringEscapeQuote = this.writeDefaultStringEscapeQuote;
    }
    this.maxAllowedPacket = maxAllowedPacket;
    if (maxAllowedPacket) {
      this.maxPacketSize = Math.min(MAX_BUFFER_SIZE, maxAllowedPacket) - this.endStrLength;
    } else this.maxPacketSize = 4194304 - this.endStrLength;

    this.buf[this.pos++] = 0x03;
    this.writeString(this.initStr);
  }

  growBuffer(len) {
    let newCapacity;
    if (len + this.pos < MEDIUM_BUFFER_SIZE) {
      newCapacity = MEDIUM_BUFFER_SIZE;
    } else if (len + this.pos < LARGE_BUFFER_SIZE) {
      newCapacity = LARGE_BUFFER_SIZE;
    } else if (len + this.pos < BIG_BUFFER_SIZE) {
      newCapacity = BIG_BUFFER_SIZE;
    } else newCapacity = MAX_BUFFER_SIZE;

    let newBuf = Buffer.allocUnsafe(Math.min(newCapacity, this.maxPacketSize));
    this.buf.copy(newBuf, 0, 0, this.pos);
    this.buf = newBuf;
  }

  writeInt8(value) {
    if (this.pos + 1 + this.endStrLength >= this.buf.length) {
      if (this.buf.length < this.maxPacketSize) {
        this.growBuffer(1);
      } else {
        this.flush(false, 1);
      }
    }
    this.buf[this.pos++] = value;
  }

  /**
   * Write ascii string to socket (no escaping)
   *
   * @param str                string
   */
  writeStringAscii(str) {
    let len = str.length;

    //not enough space remaining
    if (len >= this.buf.length - (this.pos + this.endStrLength)) {
      let strBuf = Buffer.from(str, "ascii");
      this.writeBuffer(strBuf, 0, strBuf.length);
      return;
    }

    for (let off = 0; off < len; ) {
      this.buf[this.pos++] = str.charCodeAt(off++);
    }
  }

  writeUtf8StringEscapeQuote(str) {
    const charsLength = str.length;

    //not enough space remaining
    if (charsLength * 3 + 2 >= this.buf.length - (this.pos + this.endStrLength)) {
      const arr = Buffer.from(str, "utf8");
      this.writeInt8(QUOTE);
      this.writeBufferEscape(arr);
      this.writeInt8(QUOTE);
      return;
    }

    //create UTF-8 byte array
    //since java char are internally using UTF-16 using surrogate's pattern, 4 bytes unicode characters will
    //represent 2 characters : example "\uD83C\uDFA4" = 🎤 unicode 8 "no microphones"
    //so max size is 3 * charLength
    //(escape characters are 1 byte encoded, so length might only be 2 when escape)
    // + 2 for the quotes for text protocol
    let charsOffset = 0;
    let currChar;
    this.buf[this.pos++] = QUOTE;
    //quick loop if only ASCII chars for faster escape
    for (
      ;
      charsOffset < charsLength && (currChar = str.charCodeAt(charsOffset)) < 0x80;
      charsOffset++
    ) {
      if (
        currChar === SLASH ||
        currChar === QUOTE ||
        currChar === ZERO_BYTE ||
        currChar === DBL_QUOTE
      ) {
        this.buf[this.pos++] = SLASH;
      }
      this.buf[this.pos++] = currChar;
    }

    //if quick loop not finished
    while (charsOffset < charsLength) {
      currChar = str.charCodeAt(charsOffset++);
      if (currChar < 0x80) {
        if (
          currChar === SLASH ||
          currChar === QUOTE ||
          currChar === ZERO_BYTE ||
          currChar === DBL_QUOTE
        ) {
          this.buf[this.pos++] = SLASH;
        }
        this.buf[this.pos++] = currChar;
      } else if (currChar < 0x800) {
        this.buf[this.pos++] = 0xc0 | (currChar >> 6);
        this.buf[this.pos++] = 0x80 | (currChar & 0x3f);
      } else if (currChar >= 0xd800 && currChar < 0xe000) {
        //reserved for surrogate - see https://en.wikipedia.org/wiki/UTF-16
        if (currChar < 0xdc00) {
          //is high surrogate
          if (charsOffset + 1 > charsLength) {
            this.buf[this.pos++] = 0x3f;
          } else {
            const nextChar = str.charCodeAt(charsOffset);
            if (nextChar >= 0xdc00 && nextChar < 0xe000) {
              //is low surrogate
              const surrogatePairs =
                (currChar << 10) + nextChar + (0x010000 - (0xd800 << 10) - 0xdc00);
              this.buf[this.pos++] = 0xf0 | (surrogatePairs >> 18);
              this.buf[this.pos++] = 0x80 | ((surrogatePairs >> 12) & 0x3f);
              this.buf[this.pos++] = 0x80 | ((surrogatePairs >> 6) & 0x3f);
              this.buf[this.pos++] = 0x80 | (surrogatePairs & 0x3f);
              charsOffset++;
            } else {
              //must have low surrogate
              this.buf[this.pos++] = 0x3f;
            }
          }
        } else {
          //low surrogate without high surrogate before
          this.buf[this.pos++] = 0x3f;
        }
      } else {
        this.buf[this.pos++] = 0xe0 | (currChar >> 12);
        this.buf[this.pos++] = 0x80 | ((currChar >> 6) & 0x3f);
        this.buf[this.pos++] = 0x80 | (currChar & 0x3f);
      }
    }
    this.buf[this.pos++] = QUOTE;
  }

  writeDefaultIconvString(str) {
    let buf = Iconv.encode(str, this.encoding);
    this.writeBuffer(buf, 0, buf.length);
  }

  writeDefaultBufferString(str) {
    //javascript use UCS-2 or UTF-16 string internal representation
    //that means that string to byte will be a maximum of * 3
    // (4 bytes utf-8 are represented on 2 UTF-16 characters)
    if (str.length * 3 < this.buf.length - (this.pos + this.endStrLength)) {
      this.pos += this.buf.write(str, this.pos, this.encoding);
      return;
    }

    //checking real length
    let byteLength = Buffer.byteLength(str, this.encoding);
    if (byteLength > this.buf.length - (this.pos + this.endStrLength)) {
      if (this.buf.length < this.maxPacketSize) {
        this.growBuffer(byteLength);
      }
      if (byteLength > this.buf.length - (this.pos + this.endStrLength)) {
        //not enough space in buffer, will stream :
        let strBuf = Buffer.from(str, this.encoding);
        this.writeBuffer(strBuf, 0, strBuf.length);
        return;
      }
    }
    this.pos += this.buf.write(str, this.pos, this.encoding);
  }

  /**
   * Parameters need to be properly escaped :
   * following characters are to be escaped by "\" :
   * - \0
   * - \\
   * - \'
   * - \"
   * regex split part of string writing part, and escaping special char.
   * Those chars are <= 7f meaning that this will work even with multi-byte encoding
   *
   * @param str string to escape.
   */
  writeDefaultStringEscapeQuote(str) {
    this.writeInt8(QUOTE);
    let match;
    let lastIndex = 0;
    while ((match = CHARS_GLOBAL_REGEXP.exec(str)) !== null) {
      this.writeString(str.slice(lastIndex, match.index));
      this.writeInt8(SLASH);
      this.writeInt8(match[0].charCodeAt(0));
      lastIndex = CHARS_GLOBAL_REGEXP.lastIndex;
    }

    if (lastIndex === 0) {
      // Nothing was escaped
      this.writeString(str);
      this.writeInt8(QUOTE);
      return;
    }

    if (lastIndex < str.length) {
      this.writeString(str.slice(lastIndex));
    }
    this.writeInt8(QUOTE);
  }

  writeBufferEscape(val) {
    let valLen = val.length;
    if (valLen * 2 > this.buf.length - (this.pos + this.endStrLength)) {
      //makes buffer bigger (up to 16M)
      if (this.buf.length < this.maxPacketSize) this.growBuffer(valLen * 2);

      //data may still be bigger than buffer.
      //must flush buffer when full (and reset position to 4)
      if (valLen * 2 > this.buf.length - (this.pos + this.endStrLength)) {
        //not enough space in buffer, will fill buffer
        for (let i = 0; i < valLen; i++) {
          switch (val[i]) {
            case QUOTE:
            case SLASH:
            case DBL_QUOTE:
            case ZERO_BYTE:
              if (this.pos >= this.buf.length) this.flush(false, (valLen - i) * 2);
              this.buf[this.pos++] = SLASH; //add escape slash
          }
          if (this.pos >= this.buf.length) this.flush(false, (valLen - i) * 2);
          this.buf[this.pos++] = val[i];
        }
        return;
      }
    }

    //sure to have enough place to use buffer directly
    for (let i = 0; i < valLen; i++) {
      switch (val[i]) {
        case QUOTE:
        case SLASH:
        case DBL_QUOTE:
        case ZERO_BYTE:
          this.buf[this.pos++] = SLASH; //add escape slash
      }
      this.buf[this.pos++] = val[i];
    }
  }

  writeBuffer(arr, off, len) {
    if (len > this.buf.length - (this.pos + this.endStrLength)) {
      if (this.buf.length < this.maxPacketSize) {
        this.growBuffer(len);
      }

      //max buffer size
      if (len > this.buf.length - (this.pos + this.endStrLength)) {
        //not enough space in buffer, will stream :
        // fill buffer and flush until all data are snd
        let remainingLen = len;

        while (true) {
          //filling buffer
          let lenToFillBuffer = Math.min(this.maxPacketSize - this.pos, remainingLen);
          arr.copy(this.buf, this.pos, off, off + lenToFillBuffer);
          remainingLen -= lenToFillBuffer;
          off += lenToFillBuffer;
          this.pos += lenToFillBuffer;

          if (remainingLen === 0) return;
          this.flush(false, remainingLen);
        }
      }
    }
    arr.copy(this.buf, this.pos, off, off + len);
    this.pos += len;
  }

  mark(isLast) {
    if (this.singleQuery) {
      //end of big query that is more than 16M
      //write single one
      this.writeString(this.endStr);

      if (!this.haveErrorResponse) {
        const packetSendSize = this.pos + (this.out.cmd.sequenceNo + 1) * MAX_BUFFER_SIZE;
        if (this.maxAllowedPacket && packetSendSize > this.maxAllowedPacket) {
          console.log(
            "will send a packet to db server with size > connection option 'maxAllowedPacket' (size send is " +
              packetSendSize +
              ") connection might be reset by server"
          );
        }

        this.out.buf = this.buf;
        this.out.pos = this.pos;
        this.out.flushBuffer(true, 0);
        this.pos = 4;
        this.buf = Buffer.allocUnsafe(SMALL_BUFFER_SIZE);
        this.markPos = undefined;
      }

      this.out.cmd.sequenceNo = -1;
      this.out.cmd.compressSequenceNo = -1;
      this.singleQuery = false;
      this.buf[this.pos++] = 0x03;
      this.writeString(this.initStr);
      this.markPos = undefined;
    } else {
      if (this.markPos && this.pos + this.endStrLength > this.maxPacketSize) {
        //not enough room for current query, flush mark.
        this.flushMark();
      } else {
        //just mark ending query
        this.markPos = this.pos;
        if (isLast) {
          this.flushMark();
        }
      }
      if (!isLast) this.writeStringAscii(",");
    }
  }

  flush(end, remainingLen) {
    if (this.markPos && !this.singleQuery) {
      this.flushMark();
    } else {
      //one insert is more than 16M, will continue to mono insert, hoping
      //that max_allowed_packet is sized accordingly to query.
      if (this.buf.length < MAX_BUFFER_SIZE) {
        //in this case, connector has default to 4M packet, and a single query size
        //is > to 4mb. growing buffer to 16M
        let newBuf = Buffer.allocUnsafe(MAX_BUFFER_SIZE);
        this.buf.copy(newBuf, 0, 0, this.pos);
        this.buf = newBuf;
      } else {
        if (!this.haveErrorResponse || this.out.cmd.sequenceNo !== -1) {
          if (this.maxAllowedPacket && this.buf.length > this.maxAllowedPacket) {
            console.log(
              "will send a packet to server with size > connection option 'maxAllowedPacket' (size send is " +
                this.pos +
                ") connection might be reset by server"
            );
          }
          this.out.buf = this.buf;
          this.out.pos = this.pos;
          this.out.flushBuffer(false, remainingLen);
          this.pos = 4;
          this.buf = Buffer.allocUnsafe(SMALL_BUFFER_SIZE);
          this.markPos = undefined;
          if (!this.singleQuery) this.packetSend++;
          this.singleQuery = true;
        }
      }
    }
  }

  flushMark() {
    let other;
    if (this.pos !== this.markPos) {
      //remove "," character
      other = Buffer.allocUnsafe(this.pos - this.markPos - 1);
      this.buf.copy(other, 0, this.markPos + 1, this.pos);
    }

    this.pos = this.markPos;
    this.writeString(this.endStr);

    if (!this.haveErrorResponse || this.out.cmd.sequenceNo !== -1) {
      this.out.buf = this.buf;
      this.out.pos = this.pos;
      this.out.flushBuffer(true);
      this.out.cmd.sequenceNo = -1;
      this.out.cmd.compressSequenceNo = -1;
      this.buf = Buffer.allocUnsafe(SMALL_BUFFER_SIZE);
      this.packetSend++;
    }

    this.pos = 4;
    this.buf[this.pos++] = 0x03;
    this.writeString(this.initStr);
    if (other) {
      other.copy(this.buf, this.pos, 0, other.length);
      this.pos += other.length;
    }
    this.markPos = undefined;
    this.singleQuery = false;
  }

  endedWithError() {
    this.haveErrorResponse = true;
  }
}

module.exports = WritePacket;