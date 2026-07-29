import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

interface LoadingButtonProps {
  onPress: () => void;
  loading: boolean;
  disabled?: boolean;
  style: StyleProp<ViewStyle>;
  spinnerColor: string;
  /**
   * Leading icon element shown when not loading, swapped 1:1 for the spinner
   * while loading. Omit for buttons with no icon slot — the spinner is then
   * overlaid on top of the (dimmed) label instead, so the button never
   * changes size either way.
   */
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export default function LoadingButton({
  onPress,
  loading,
  disabled,
  style,
  spinnerColor,
  icon,
  children,
}: LoadingButtonProps) {
  return (
    <Pressable style={style} disabled={disabled} onPress={onPress}>
      {icon ? (
        <>
          {loading ? <ActivityIndicator color={spinnerColor} /> : icon}
          {children}
        </>
      ) : (
        <View style={styles.overlayWrap}>
          <View style={loading ? styles.dimmedContent : undefined}>
            {children}
          </View>
          {loading ? (
            <View style={styles.spinnerOverlay} pointerEvents="none">
              <ActivityIndicator color={spinnerColor} />
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlayWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmedContent: {
    opacity: 0.6,
  },
  spinnerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
