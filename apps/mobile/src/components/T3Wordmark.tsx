import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The CodeRelay hub mark (one node relaying to two teammates), matching the
 * web app's CodeRelayGlyph. Filled geometry only, so it tints through
 * `currentColor` like the other brand marks. The square viewBox keeps the
 * glyph undistorted at any height.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="CodeRelay"
      height={props.height}
      width={props.height}
      viewBox="4 4 24 24"
    >
      <ThemedPath
        d="M5.6 16a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z M19.6 9a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z M19.6 23a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z M9.4919 16.9838L23.4919 9.9838L22.5081 8.0162L8.5081 15.0162Z M8.5081 16.9838L22.5081 23.9838L23.4919 22.0162L9.4919 15.0162Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
