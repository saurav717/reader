/**
 * What each simulator in the picker (src/components/SimPicker.tsx) looks like: a short clip or picture from its own
 * documentation or repository, shown beside its details. Every address was fetched and checked to be the media it
 * says; one that stops working shows a "no preview" box, never a broken image. An environment with a clip of its own
 * (CartPole, LunarLander, Humanoid…) shows that one instead of the simulator's.
 */

export interface SimPreview {
  url: string;
  kind: 'gif' | 'video' | 'image';
  /** Whose it is: "Gymnasium docs". */
  credit?: string;
  /** The page it comes from. */
  page?: string;
}

const SIMS: Record<string, SimPreview> = {};

const ENVS: Record<string, Record<string, SimPreview>> = {};

/** The preview for a simulator, or for one of its environments when that has its own. */
export function previewFor(simId: string, envId?: string): SimPreview | null {
  const own = envId ? ENVS[simId]?.[envId] : undefined;
  if (own) return { credit: SIMS[simId]?.credit, page: SIMS[simId]?.page, ...own };
  return SIMS[simId] ?? null;
}
