export const FINISHED_AT = 0.98;
export function statusOf(paper) {
    if (paper.progress >= FINISHED_AT)
        return 'finished';
    return paper.progress > 0 ? 'reading' : 'unread';
}
export const STATUS_LABEL = {
    reading: 'Reading now',
    unread: 'Not started',
    finished: 'Finished',
};
/** The order the left panel shows the groups in: in flight, then to come. */
export const STATUS_ORDER = ['reading', 'unread', 'finished'];
