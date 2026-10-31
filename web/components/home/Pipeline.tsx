type Stage = {
  readonly bytes: number;
  readonly label: string;
  readonly clause: string;
};

const MIN_SHARE = 0.12;
const tones = ["registry", "tarball", "source", "compare"] as const;

// Each stage's share of the bar follows the bytes it read, with a floor so the
// small stages stay legible; the floor is taken from the stages above it.
export function shares(values: readonly number[], min = MIN_SHARE): number[] {
  const floored = new Set<number>();
  for (;;) {
    const free = values.reduce(
      (sum, v, i) => (floored.has(i) ? sum : sum + v),
      0,
    );
    const room = 1 - floored.size * min;
    let changed = false;
    values.forEach((v, i) => {
      if (!floored.has(i) && (v / free) * room < min) {
        floored.add(i);
        changed = true;
      }
    });
    if (!changed)
      return values.map((v, i) => (floored.has(i) ? min : (v / free) * room));
  }
}

export function Pipeline({ stages }: { stages: readonly Stage[] }) {
  const widths = shares(stages.map((s) => s.bytes));
  let offset = 0;
  return (
    <figure className="stages-figure" data-ui>
      <ol className="stages">
        {stages.map((stage, i) => {
          const x = offset;
          offset += widths[i];
          return (
            <li
              key={stage.label}
              className={`stage stage-${tones[i % tones.length]}`}
              style={{
                ["--x" as string]: x,
                ["--w" as string]: widths[i],
                ["--i" as string]: i,
              }}
            >
              <div
                className="stage-block"
                data-part
                style={{ ["--part" as string]: i + 2 }}
              >
                <span className="stage-amount">
                  {stage.label}
                  <span className="visually-hidden"> read.</span>
                </span>
              </div>
              <div
                className="stage-text"
                data-part
                style={{ ["--part" as string]: i + 4 }}
              >
                <span className="stage-swatch" aria-hidden="true" />
                <p className="stage-clause">{stage.clause}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
