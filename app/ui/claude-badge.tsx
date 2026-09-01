/**
 * Marks the places where the system waits on Claude rather than on the engine.
 *
 * Without it, a lead sitting unclassified for forty minutes looks broken, when it is
 * simply queued for the next routine run. The badge is the difference between "stuck" and
 * "scheduled".
 */
export default function ClaudeBadge({ note }: { note?: string }) {
  return (
    <span className="claude-badge" title={note ?? "Handled by Claude on its next run"}>
      <span aria-hidden="true">✦</span> Claude
      {note && <span className="claude-note">{note}</span>}
    </span>
  );
}
