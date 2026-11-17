const CR = '\r';
const LF = '\n';

interface LineBreaks {
  breaks: number;
  crlf: number;
}

function countLineBreaks(text: string): LineBreaks {
  let breaks = 0;
  let crlf = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === CR && text[index + 1] === LF) {
      breaks += 1;
      crlf += 1;
      index += 1;
    } else if (char === CR || char === LF) {
      breaks += 1;
    }
  }

  return { breaks, crlf };
}

function isLineBreak(char: string | undefined): boolean {
  return char === CR || char === LF;
}

export function trimLineBreaks(text: string): string {
  let start = 0;
  let end = text.length;

  while (start < end && isLineBreak(text[start])) {
    start += 1;
  }

  while (end > start && isLineBreak(text[end - 1])) {
    end -= 1;
  }

  return text.slice(start, end);
}

export class CsvLineTracker {
  private drift = 0;

  recordStartLine(fields: readonly string[], parserEndLine: number): number {
    const { breaks, crlf } = countLineBreaks(fields.join(''));

    const endLine = parserEndLine - this.drift - crlf;
    this.drift += crlf;

    return endLine - breaks;
  }

  skippedStartLine(raw: string, parserLine: number): number {
    const { crlf } = countLineBreaks(raw);
    const { breaks } = countLineBreaks(trimLineBreaks(raw));

    const detectedLine = parserLine - this.drift - crlf;
    this.drift += crlf;

    return detectedLine - breaks;
  }
}
