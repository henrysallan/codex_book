/** Calls native code can make into the editor web view. */
export type NoteEditorHandle = {
  /** Send any debounced, unsent edit now. */
  flush: () => void;
  /** Drop focus, which dismisses the keyboard. */
  blur: () => void;
};
