import type { ReactNode } from 'react';

/**
 * What a sentence names in code (`__subject__`, `he.json, en.json`, `m-harbour-launch`,
 * `pnpm dev`, `pnpm library login`), each a run of its own from left to right: in a sentence in
 * Hebrew or Arabic, the page would otherwise move its underscores, its dots and its commas to the
 * far side.
 */
const CODE =
  /(__\w+__|[\w-]+\.(?:json|webp)(?:[,،]‏?\s*[\w-]+\.(?:json|webp))*|\bm-[a-z0-9-]*|pnpm (?:dev|library(?: [a-z-]+)?)|\(x, y\))/g;

export function isolate(text: string): ReactNode {
  const parts = text.split(CODE);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <bdi key={index} dir="ltr">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}
