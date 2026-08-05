export function parsePlannerJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectStart = cleaned.indexOf('{');
    const objectEnd = cleaned.lastIndexOf('}');
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    const candidates: string[] = [];
    if (objectStart >= 0 && objectEnd > objectStart) candidates.push(cleaned.slice(objectStart, objectEnd + 1));
    if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Continue through bounded JSON-looking candidates.
      }
    }
    throw new Error(`Planner returned non-JSON content:\n${text.slice(0, 500)}`);
  }
}
