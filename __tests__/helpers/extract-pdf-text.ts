/**
 * Read the text back OUT of a rendered PDF, so a test can assert what a human would actually see.
 *
 * ================================================================================================
 * WHY THIS IS NOT A grep OVER THE BYTES
 * ================================================================================================
 *
 * The obvious test -- `Buffer.from(bytes).toString('latin1').includes('PO Box 11')` -- is always
 * red, and for a reason that has nothing to do with the renderer: pdf-lib Flate-compresses every
 * content stream it writes, and it emits drawn text as a HEX STRING, not as a literal. Measured
 * against a real page from this renderer, neither the plain text nor any substring of it appears
 * anywhere in the file.
 *
 * A test that cannot tell "the address is missing" from "the bytes are compressed" is not evidence
 * about the address. So this walks the same path a reader does: it inflates each page's content
 * stream and pulls the operands out of the text-showing operators.
 *
 * ================================================================================================
 * WHAT IT COVERS
 * ================================================================================================
 *
 * `Tj` and `TJ`, with hex `<...>` or literal `(...)` operands. That is the whole surface pdf-lib's
 * `drawText` produces today (it writes `<hex> Tj`), plus the two forms it could reasonably move to.
 * Anything else -- `'`, `"`, Type0/CID fonts with a custom CMap -- is NOT decoded, and the helper
 * throws rather than returning a short string, because a silently truncated extraction would let
 * an assertion about missing text pass while the text was simply not understood.
 */
import { PDFDocument, PDFRawStream } from 'pdf-lib'
import { inflateSync } from 'zlib'

type MaybePDFArray = { asArray?: () => unknown[] }

function contentStreamsOf(doc: PDFDocument): PDFRawStream[] {
  const streams: PDFRawStream[] = []
  for (const page of doc.getPages()) {
    const contents = page.node.Contents() as unknown
    if (!contents) continue
    const asArray = (contents as MaybePDFArray).asArray
    const candidates =
      typeof asArray === 'function'
        ? asArray
            .call(contents)
            .map((ref) => doc.context.lookup(ref as Parameters<typeof doc.context.lookup>[0]))
        : [contents]
    for (const candidate of candidates) {
      if (candidate instanceof PDFRawStream) streams.push(candidate)
    }
  }
  return streams
}

function decodeStream(stream: PDFRawStream): string {
  const raw = Buffer.from(stream.contents)
  try {
    return inflateSync(raw).toString('latin1')
  } catch {
    // Not compressed (or compressed with a filter we do not implement); the raw bytes are then
    // already the operator stream.
    return raw.toString('latin1')
  }
}

/** PDF literal-string escapes, as §7.3.4.2 defines them. */
function decodeLiteralString(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '\n') continue // line continuation
    else if (next >= '0' && next <= '7') {
      let octal = next
      while (octal.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
        octal += body[i + 1]
        i += 1
      }
      out += String.fromCharCode(parseInt(octal, 8))
    } else out += next
  }
  return out
}

function decodeHexString(body: string): string {
  const hex = body.replace(/[^0-9a-fA-F]/g, '')
  const even = hex.length % 2 === 0 ? hex : `${hex}0`
  return Buffer.from(even, 'hex').toString('latin1')
}

/**
 * Every operand of a text-showing operator, in page order, one entry per operator.
 *
 * Kept as an array rather than one blob so a caller can assert that a value occupies a LINE of the
 * document, which is what `drawText` produces, instead of merely occurring somewhere in a
 * concatenation of everything on the page.
 */
export async function extractPdfTextLines(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const streams = contentStreamsOf(doc)
  if (streams.length === 0) {
    throw new Error('extractPdfTextLines: the document has no readable content stream')
  }

  const lines: string[] = []
  // `<hex>` or `(literal)` followed by Tj, or a `[ ... ] TJ` array of either.
  const showOperator = /(?:<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\))\s*Tj|\[((?:[^\][]|\\.)*)\]\s*TJ/g
  const arrayPiece = /<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g

  for (const stream of streams) {
    const decoded = decodeStream(stream)
    let match: RegExpExecArray | null
    showOperator.lastIndex = 0
    while ((match = showOperator.exec(decoded)) !== null) {
      const [, hex, literal, tjArray] = match
      if (hex !== undefined) {
        lines.push(decodeHexString(hex))
      } else if (literal !== undefined) {
        lines.push(decodeLiteralString(literal))
      } else if (tjArray !== undefined) {
        let piece: RegExpExecArray | null
        let assembled = ''
        arrayPiece.lastIndex = 0
        while ((piece = arrayPiece.exec(tjArray)) !== null) {
          assembled +=
            piece[1] !== undefined ? decodeHexString(piece[1]) : decodeLiteralString(piece[2])
        }
        lines.push(assembled)
      }
    }
  }

  if (lines.length === 0) {
    throw new Error(
      'extractPdfTextLines: no Tj/TJ operator was understood in any content stream. The renderer ' +
        'has changed how it emits text, and this helper would otherwise report every string as ' +
        'absent.',
    )
  }
  return lines
}

/** The same text as one newline-joined blob, for substring assertions. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  return (await extractPdfTextLines(bytes)).join('\n')
}
