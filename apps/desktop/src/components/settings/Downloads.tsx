import { Group, Row, TextInput } from "../SettingsFields";
import { usePref } from "./usePref";

/** Settings › Downloads. */
export function Downloads() {
  const [prefs, set] = usePref();
  return (
    <Group title="Files">
      <Row
        label="Save files to"
        htmlFor="pref-downloads"
        hint="Leave empty for ~/Downloads. A name already taken gets a “ (2)” suffix rather than overwriting."
        control={
          <TextInput
            id="pref-downloads"
            label="Save files to"
            mono
            width="w-[300px]"
            value={prefs.download_dir}
            placeholder="~/Downloads"
            onCommit={(download_dir) => set({ download_dir })}
          />
        }
      />
    </Group>
  );
}
