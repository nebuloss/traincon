/**
 * What counts as a link to a single train.
 *
 * Shared because two places have to agree: the client router, which opens the
 * modal, and the server, which builds the link-preview tags for whatever a
 * crawler asks for. The hash forms live in the router alone — a fragment is
 * never sent to the server, so it cannot see them.
 */

/** Train numbers are short and alphanumeric; anything else is not a link. */
export const TRAIN_NUMBER = /^[A-Za-z0-9]{1,8}$/;

/** `/train/8540`, `/train/8540/carte` or `/t/8540` → `8540`. */
export function trainFromPath(pathname: string): { train: string; tab?: string } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== 'train' && parts[0] !== 't') return null;

  const n = parts[1]!;
  if (!TRAIN_NUMBER.test(n)) return null;
  return parts[2] ? { train: n.toUpperCase(), tab: parts[2] } : { train: n.toUpperCase() };
}

/** `?train=8540&tab=carte` → `8540`. */
export function trainFromQuery(search: string): { train: string; tab?: string } | null {
  const params = new URLSearchParams(search);
  const n = params.get('train') ?? params.get('t');
  if (!n || !TRAIN_NUMBER.test(n)) return null;

  const tab = params.get('tab');
  return tab ? { train: n.toUpperCase(), tab } : { train: n.toUpperCase() };
}
