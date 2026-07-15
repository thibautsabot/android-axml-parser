// AXML is Android's binary XML format. When you build an APK, Android compiles
// every XML file (manifest, layouts, resources) into this compact binary format.
// Unzipping an APK gives you the binary version — not readable as plain text.
//
// Binary AXML structure: a sequence of "chunks" laid out back to back:
//
//   [File header]    validates this is a valid AXML file
//   [String pool]    all strings in the file, stored exactly once
//   [Start element]  e.g. <manifest package="com.example">
//   [Start element]  e.g. <uses-permission android:name="...">
//   [End element]    e.g. </uses-permission>
//   [End element]    e.g. </manifest>
//   ...
//
// Every chunk starts with the same 8-byte header:
//   offset 0: type       (uint16) — what kind of chunk this is
//   offset 2: headerSize (uint16) — how many bytes in the header
//   offset 4: totalSize  (uint32) — how many bytes in the whole chunk
//
// The string pool is the key: instead of embedding "android.permission.CAMERA"
// everywhere, the file stores it once in the pool and every other reference is
// just an integer index. Parsing the pool first gives us a lookup table.

// ── Chunk type identifiers ────────────────────────────────────────────────────
const RES_XML_TYPE = 0x0003;               // file header
const RES_STRING_POOL_TYPE = 0x0001;       // string pool chunk
const RES_XML_START_ELEMENT_TYPE = 0x0102; // opening tag
const RES_XML_END_ELEMENT_TYPE = 0x0103;   // closing tag

// ── String pool flags ─────────────────────────────────────────────────────────
const UTF8_FLAG = 0x00000100; // if set, strings are UTF-8; otherwise UTF-16LE

// ── Sentinel ─────────────────────────────────────────────────────────────────
const NO_INDEX = 0xffffffff; // means "no string" (attribute has no raw string value)

// ── Attribute value types ────────────────────────────────────────────────────
// Each attribute carries a typed value. These constants identify the type.
const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01; // reference to another resource, e.g. @0x7f040001
const TYPE_ATTRIBUTE = 0x02; // reference to a theme attribute, e.g. ?0x01010001
const TYPE_STRING = 0x03;    // index into the string pool
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;   // decimal integer
const TYPE_INT_HEX = 0x11;   // hex integer, e.g. 0xff
const TYPE_INT_BOOLEAN = 0x12; // 0 = false, anything else = true

// ── Public types ──────────────────────────────────────────────────────────────

export interface AXmlAttribute {
  name: string;
  value: string | undefined;
}

export interface AXmlElement {
  name: string;
  attributes: AXmlAttribute[];
  children: AXmlElement[];
}

export interface AXmlDocument {
  strings: string[];      // full string pool — every string in the file
  root: AXmlElement | null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function parseAxml(buffer: Buffer): AXmlDocument {
  assertRange(buffer, 0, 8, "XML header");
  const xmlType = buffer.readUInt16LE(0);
  const xmlHeaderSize = buffer.readUInt16LE(2);
  const xmlSize = buffer.readUInt32LE(4);

  if (xmlType !== RES_XML_TYPE) {
    throw new Error(`Unexpected Android binary XML type 0x${xmlType.toString(16)}`);
  }
  if (xmlSize > buffer.length || xmlHeaderSize < 8) {
    throw new Error("Invalid Android binary XML header");
  }

  let strings: string[] = [];
  let root: AXmlElement | null = null;
  const elementStack: AXmlElement[] = [];

  let cursor = xmlHeaderSize;
  while (cursor + 8 <= xmlSize) {
    const type = buffer.readUInt16LE(cursor);
    const headerSize = buffer.readUInt16LE(cursor + 2);
    const size = buffer.readUInt32LE(cursor + 4);

    if (headerSize < 8 || size < headerSize || cursor + size > xmlSize) {
      throw new Error(`Invalid Android XML chunk at offset ${cursor}`);
    }

    if (type === RES_STRING_POOL_TYPE) {
      // Must appear before any element chunks; gives us the lookup table.
      strings = parseStringPool(buffer, cursor, headerSize, size);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const { name, attributes } = parseStartElement(buffer, cursor, size, strings);
      const element: AXmlElement = { name, attributes, children: [] };
      if (elementStack.length > 0) {
        elementStack[elementStack.length - 1]!.children.push(element);
      } else {
        root = element;
      }
      elementStack.push(element);
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      elementStack.pop();
    }
    // Unknown chunk types are silently skipped — the size field lets us jump over them.

    cursor += size;
  }

  return { strings, root };
}

// ── String pool ───────────────────────────────────────────────────────────────
// Layout of the string pool chunk:
//   +8  stringCount  (uint32)
//   +12 styleCount   (uint32) — style spans, not needed here
//   +16 flags        (uint32) — bit 8 = UTF-8 encoding
//   +20 stringsStart (uint32) — offset from chunk start to string data
//   +24 stylesStart  (uint32) — 0 if no styles
//   +headerSize: array of uint32 offsets, one per string (relative to stringsStart)
//   +stringsStart: packed string data, each string length-prefixed

function parseStringPool(
  buffer: Buffer,
  chunkOffset: number,
  headerSize: number,
  chunkSize: number,
): string[] {
  assertRange(buffer, chunkOffset, headerSize, "string pool header");
  const stringCount = buffer.readUInt32LE(chunkOffset + 8);
  const styleCount = buffer.readUInt32LE(chunkOffset + 12);
  const flags = buffer.readUInt32LE(chunkOffset + 16);
  const stringsStart = buffer.readUInt32LE(chunkOffset + 20);
  const stylesStart = buffer.readUInt32LE(chunkOffset + 24);

  // The offset array sits right after the header.
  const offsetsStart = chunkOffset + headerSize;
  const offsetsLength = (stringCount + styleCount) * 4; // 4 bytes per uint32 offset
  assertRange(buffer, offsetsStart, offsetsLength, "string pool offsets");

  const stringsBase = chunkOffset + stringsStart;
  const stringsEnd = stylesStart === 0 ? chunkOffset + chunkSize : chunkOffset + stylesStart;
  if (stringsBase > stringsEnd || stringsEnd > chunkOffset + chunkSize) {
    throw new Error("Invalid Android string pool boundaries");
  }

  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = [];

  for (let index = 0; index < stringCount; index += 1) {
    // Each entry in the offset array gives the position of the string
    // relative to the start of the string data section.
    const relativeOffset = buffer.readUInt32LE(offsetsStart + index * 4);
    const absoluteOffset = stringsBase + relativeOffset;
    if (absoluteOffset >= stringsEnd) {
      throw new Error(`String ${index} points outside the Android string pool`);
    }
    strings.push(
      utf8
        ? readUtf8String(buffer, absoluteOffset, stringsEnd)
        : readUtf16String(buffer, absoluteOffset, stringsEnd),
    );
  }

  return strings;
}

// ── String readers ────────────────────────────────────────────────────────────
// Android uses a non-standard length prefix scheme:
//   UTF-8 strings:  length is encoded as 1 or 2 bytes (high bit = extended)
//   UTF-16 strings: length is encoded as 1 or 2 uint16s (high bit = extended)
// There are TWO length fields for UTF-8 strings: character count then byte count.

function readUtf8String(buffer: Buffer, offset: number, end: number): string {
  const utf16Length = readLength8(buffer, offset, end); // character count (ignored)
  const byteLength = readLength8(buffer, utf16Length.nextOffset, end); // byte count
  const start = byteLength.nextOffset;
  const finish = start + byteLength.value;
  if (finish > end) {
    throw new Error("UTF-8 string exceeds Android string pool bounds");
  }
  return buffer.toString("utf8", start, finish);
}

function readUtf16String(buffer: Buffer, offset: number, end: number): string {
  const length = readLength16(buffer, offset, end); // character count (each is 2 bytes)
  const start = length.nextOffset;
  const finish = start + length.value * 2;
  if (finish > end) {
    throw new Error("UTF-16 string exceeds Android string pool bounds");
  }
  return buffer.toString("utf16le", start, finish);
}

// Reads a variable-length string length encoded as 1 or 2 bytes (used for UTF-8 strings).
// The high bit of the first byte signals whether a second byte is needed:
//   0x80 = 10000000 — masking with 0x80 isolates that top bit
//   - top bit 0 → length fits in the remaining 7 bits, done in 1 byte
//     e.g. 0x2A → length 42
//   - top bit 1 → length needs 15 bits: strip the top bit with 0x7f (01111111),
//     shift those 7 bits up by 8, then OR in the full second byte
//     e.g. 0x81 0x05 → (0x01 << 8) | 0x05 = 261
function readLength8(
  buffer: Buffer,
  offset: number,
  end: number,
): { value: number; nextOffset: number } {
  if (offset >= end) {
    throw new Error("Truncated Android UTF-8 string length");
  }
  const first = buffer[offset]!;
  if ((first & 0x80) === 0) {
    // Top bit is 0 → single byte, value is the byte itself.
    return { value: first, nextOffset: offset + 1 };
  }
  if (offset + 1 >= end) {
    throw new Error("Truncated Android UTF-8 string length");
  }
  // Top bit is 1 → two bytes. Strip the top bit of the first byte with 0x7f,
  // shift it left to make room, then OR in the second byte.
  return {
    value: ((first & 0x7f) << 8) | buffer[offset + 1]!,
    nextOffset: offset + 2,
  };
}

// Same variable-length encoding but using uint16 units (for UTF-16 strings).
//   0x8000 = 1000000000000000 — isolates the top bit of a uint16
//   - top bit 0 → length fits in 15 bits, done in one uint16 (2 bytes)
//   - top bit 1 → strip the top bit with 0x7fff (0111111111111111),
//     shift those 15 bits up by 16, then OR in the second uint16
function readLength16(
  buffer: Buffer,
  offset: number,
  end: number,
): { value: number; nextOffset: number } {
  if (offset + 2 > end) {
    throw new Error("Truncated Android UTF-16 string length");
  }
  const first = buffer.readUInt16LE(offset);
  if ((first & 0x8000) === 0) {
    // Top bit is 0 → single uint16, value is the uint16 itself.
    return { value: first, nextOffset: offset + 2 };
  }
  if (offset + 4 > end) {
    throw new Error("Truncated Android UTF-16 string length");
  }
  // Top bit is 1 → two uint16s. Strip the top bit with 0x7fff,
  // shift left to make room, then OR in the second uint16.
  return {
    value: ((first & 0x7fff) << 16) | buffer.readUInt16LE(offset + 2),
    nextOffset: offset + 4,
  };
}

// ── Start element ─────────────────────────────────────────────────────────────
// Start-element chunk layout (after the 8-byte common header):
//   +8  lineNumber     (uint32) — source line, ignored
//   +12 comment        (uint32) — string index or NO_INDEX
//   +16 ns             (uint32) — namespace string index
//   +20 name           (uint32) — element name string index
//   +24 attributeStart (uint16) — offset from +16 to the first attribute
//   +26 attributeSize  (uint16) — bytes per attribute (always 20)
//   +28 attributeCount (uint16)
//   +30 idIndex        (uint16) — index of the "id" attribute, or 0
//   +32 classIndex     (uint16)
//   +34 styleIndex     (uint16)
//   +attributeStart: array of attributes, each 20 bytes:
//     +0  ns        (uint32) — namespace string index
//     +4  name      (uint32) — attribute name string index
//     +8  rawValue  (uint32) — string index for the raw value, or NO_INDEX
//     +12 valueSize (uint16)
//     +14 (padding)
//     +15 dataType  (uint8)  — one of the TYPE_* constants above
//     +16 data      (uint32) — typed value payload

function parseStartElement(
  buffer: Buffer,
  chunkOffset: number,
  chunkSize: number,
  strings: string[],
): { name: string; attributes: AXmlAttribute[] } {
  assertRange(buffer, chunkOffset, Math.min(chunkSize, 36), "start element");
  const nameIndex = buffer.readUInt32LE(chunkOffset + 20);
  const attributeStart = buffer.readUInt16LE(chunkOffset + 24);
  const attributeSize = buffer.readUInt16LE(chunkOffset + 26);
  const attributeCount = buffer.readUInt16LE(chunkOffset + 28);
  const attributesOffset = chunkOffset + 16 + attributeStart;

  if (attributeSize < 20) {
    throw new Error(`Unsupported Android XML attribute size ${attributeSize}`);
  }
  if (attributesOffset + attributeCount * attributeSize > chunkOffset + chunkSize) {
    throw new Error("Android XML attributes exceed element chunk bounds");
  }

  const attributes: AXmlAttribute[] = [];
  for (let index = 0; index < attributeCount; index += 1) {
    const offset = attributesOffset + index * attributeSize;
    const attributeNameIndex = buffer.readUInt32LE(offset + 4);
    const rawValueIndex = buffer.readUInt32LE(offset + 8);
    const dataType = buffer[offset + 15]!;
    const data = buffer.readUInt32LE(offset + 16);
    const name = getString(strings, attributeNameIndex) ?? `attribute_${attributeNameIndex}`;
    // rawValue is a human-readable string version of the value (when present).
    // Fall back to decoding the typed data field when rawValue is absent.
    const rawValue = getString(strings, rawValueIndex);
    const value = rawValue ?? decodeTypedValue(strings, dataType, data);
    attributes.push({ name, value });
  }

  return {
    name: getString(strings, nameIndex) ?? `element_${nameIndex}`,
    attributes,
  };
}

// Converts a typed attribute value to a string representation.
function decodeTypedValue(
  strings: string[],
  dataType: number,
  data: number,
): string | undefined {
  switch (dataType) {
    case TYPE_NULL:
      return undefined;
    case TYPE_STRING:
      return getString(strings, data);
    case TYPE_INT_DEC:
      return String(data);
    case TYPE_INT_HEX:
      return `0x${data.toString(16)}`;
    case TYPE_INT_BOOLEAN:
      return data !== 0 ? "true" : "false";
    case TYPE_FLOAT: {
      // The 32-bit data field holds the IEEE 754 float bits — reinterpret them.
      const value = Buffer.allocUnsafe(4);
      value.writeUInt32LE(data, 0);
      return String(value.readFloatLE(0));
    }
    case TYPE_REFERENCE:
      return `@0x${data.toString(16)}`;
    case TYPE_ATTRIBUTE:
      return `?0x${data.toString(16)}`;
    default:
      return String(data);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getString(strings: string[], index: number): string | undefined {
  if (index === NO_INDEX) {
    return undefined;
  }
  return strings[index];
}

function assertRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Truncated ${label}`);
  }
}
