/**
 * Modal overlays: the help sheet, list pickers, confirmations, and a
 * blocking progress note. Only one can be open at a time, and while one
 * is open the keybinding registry routes every key here — a picker must
 * not be able to change hidden state behind itself.
 */
export type PickerTopic = 'theme' | 'auto-refresh' | 'account-action';

export type ConfirmTopic =
  | 'account-add'
  | 'account-detach'
  | 'account-remove'
  | 'account-switch'
  | 'daemon-install'
  | 'daemon-uninstall'
  | 'ledger-compact';

export interface PickerOption {
  readonly id: string;
  readonly label: string;
  /** Right-aligned detail, e.g. the current value or a caveat. */
  readonly hint?: string;
  /** Rendered dim and not selectable. */
  readonly disabled?: boolean;
}

export interface PickerOverlay {
  readonly kind: 'picker';
  readonly topic: PickerTopic;
  readonly title: string;
  readonly options: readonly PickerOption[];
  readonly index: number;
}

export interface ConfirmOverlay {
  readonly kind: 'confirm';
  readonly topic: ConfirmTopic;
  readonly title: string;
  readonly message: string;
  /** Opaque target the controller hands back to the action handler. */
  readonly payload: string;
}

export interface InputOverlay {
  readonly kind: 'input';
  readonly title: string;
  readonly prompt: string;
  readonly value: string;
}

export interface NoticeOverlay {
  readonly kind: 'notice';
  readonly title: string;
  readonly message: string;
  /** true while an action runs: the overlay cannot be dismissed. */
  readonly busy: boolean;
}

export type TuiOverlay =
  | { readonly kind: 'help' }
  | PickerOverlay
  | ConfirmOverlay
  | InputOverlay
  | NoticeOverlay
  | null;

/** Printable keys arrive one at a time; everything else is a control key. */
export function editInput(overlay: InputOverlay, key: { name: string }): InputOverlay | null {
  if (key.name === 'backspace') {
    return { ...overlay, value: overlay.value.slice(0, -1) };
  }
  if (key.name === 'space') {
    return { ...overlay, value: `${overlay.value} ` };
  }
  if ([...key.name].length === 1) {
    return { ...overlay, value: overlay.value + key.name };
  }
  return null;
}

export const HELP_OVERLAY = { kind: 'help' } as const;

/** Wraps around, skipping options that cannot be chosen. */
export function movePicker(picker: PickerOverlay, delta: number): PickerOverlay {
  const count = picker.options.length;
  if (count === 0) {
    return picker;
  }
  let index = picker.index;
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count;
    if (picker.options[index]?.disabled !== true) {
      return { ...picker, index };
    }
  }
  return picker;
}

export function selectedOption(picker: PickerOverlay): PickerOption | null {
  const option = picker.options[picker.index];
  return option === undefined || option.disabled === true ? null : option;
}

/** Opens on the current value when there is one, else the first choice. */
export function makePicker(
  topic: PickerTopic,
  title: string,
  options: readonly PickerOption[],
  selectedId: string | null,
): PickerOverlay {
  const found = options.findIndex((option) => option.id === selectedId && option.disabled !== true);
  const fallback = options.findIndex((option) => option.disabled !== true);
  return {
    kind: 'picker',
    topic,
    title,
    options,
    index: found >= 0 ? found : Math.max(0, fallback),
  };
}
