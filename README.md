# axml-parser

Android binary XML (AXML) parser for Node.js.

When you build an Android APK, every XML file — the manifest, layouts, resources — gets compiled into a compact binary format called AXML. Unzipping an APK gives you these binary files, not human-readable XML. This library parses them back into a typed element tree.

## Install

```sh
npm install android-axml-parser
```

Requires Node.js ≥ 20.

## Usage

```ts
import { parseAxml } from "android-axml-parser";

// buffer is the raw bytes of a binary AXML file
const doc = parseAxml(buffer);

console.log(doc.root?.name); // "manifest"

for (const child of doc.root?.children ?? []) {
  console.log(child.name, child.attributes);
}
```

## API

### `parseAxml(buffer: Buffer): AXmlDocument`

Parses an Android binary XML buffer and returns the document tree.

Throws if the buffer is not a valid AXML file (wrong magic bytes, truncated chunks, out-of-bounds references).

### Types

```ts
interface AXmlDocument {
  strings: string[];       // full string pool — every string in the file
  root: AXmlElement | null;
}

interface AXmlElement {
  name: string;
  attributes: AXmlAttribute[];
  children: AXmlElement[];
}

interface AXmlAttribute {
  name: string;
  value: string | undefined;
}
```

Attribute values are decoded from their typed representation:

| AXML type | Decoded as |
|-----------|------------|
| String | string pool lookup |
| Boolean | `"true"` / `"false"` |
| Decimal integer | `"42"` |
| Hex integer | `"0xff"` |
| Float | `"3.14"` |
| Resource reference | `"@0x7f040001"` |
| Theme attribute | `"?0x01010001"` |

## License

MIT
