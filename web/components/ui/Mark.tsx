export function Mark({ ok }: { ok: boolean }) {
  return (
    <svg
      className={`mark-icon ${ok ? "ok" : "no"}`}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      {ok ? (
        <path
          d="M2 6.5 4.8 9 10 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      ) : (
        <path
          d="m3 3 6 6M9 3 3 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      )}
    </svg>
  );
}
