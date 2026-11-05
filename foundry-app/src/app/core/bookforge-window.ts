/**
 * What BookForge's copy of the window leaves out (docs/REORG-PLAN.md, B3).
 *
 * NO PAGE TOOLS. Owen ruled that BookForge's window has none: no light table and
 * no "Edit book". Hosted, the window already had no "Photograph a book…", no
 * workspace for dropped photographs and no taking a dropped PDF apart; the two
 * doors still open were the action menu's "Edit book" and "Edit the photographs",
 * and this is what shuts them. The capture code, its components and its IPC doors
 * stay in the tree, unreached, so putting them back is this one line.
 */
export const PAGE_TOOLS = false;
