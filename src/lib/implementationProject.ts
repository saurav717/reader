// A Project for every implementation of a paper. A playground made from a paper — the Playground's "from a paper",
// the Implementation page's "Open as a project…" — gets a Project of its own (a collection with a question, the
// paper as its core, and the playground as its code), so that every run the playground makes is filed in that
// project's logbook with notes, videos and results (src/lib/experimentFiling.ts files into the project whose
// `playgroundId` is the playground's), rather than under a lone playground with no logbook to hold them.

import { useCallback } from 'react';
import { COLLECTION_COLORS } from '../types';
import { newProjectInfo, projectNameFor, projectQuestionFor, projectsOf } from './projects';
import { useStore } from './store';

/**
 * The project that holds a playground's code — made now when there is none: named after the paper, the paper in
 * it as its core, the playground as its code. Answers the project's id, or null when the paper is not in the
 * library. Idempotent: a playground that already has a project keeps it.
 */
export function useProjectForImplementation() {
  const { collections, papers, createCollection, updateCollection, setPaperCollections } = useStore();
  return useCallback(
    async (paperId: string, playground: { id: string; title: string }): Promise<string | null> => {
      const paper = papers.find((item) => item.id === paperId);
      if (!paper) return null;
      const projects = projectsOf(collections);
      const has = projects.find((project) => project.project.playgroundId === playground.id);
      if (has) return has.id;
      const used = new Set(projects.map((project) => project.color));
      const color = COLLECTION_COLORS.find((item) => !used.has(item)) ?? COLLECTION_COLORS[projects.length % COLLECTION_COLORS.length];
      const made = await createCollection(projectNameFor(paper.title, collections.map((item) => item.name)));
      await updateCollection(made.id, { color, project: { ...newProjectInfo(projectQuestionFor(paper.title)), roles: { [paper.id]: 'core' }, playgroundId: playground.id } });
      await setPaperCollections(paper.id, Array.from(new Set([...paper.collectionIds, made.id])));
      return made.id;
    },
    [collections, papers, createCollection, updateCollection, setPaperCollections],
  );
}
