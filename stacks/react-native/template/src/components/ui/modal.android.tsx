import React from 'react';
import { Modal, StyleSheet, Text, View, Pressable } from 'react-native';

export interface PlatformModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  children?: React.ReactNode;
}

/**
 * Android-specialized platform modal.
 * Uses fade presentation with Android hardware back-button integration.
 */
export const PlatformModal: React.FC<PlatformModalProps> = ({
  visible,
  onClose,
  title,
  children,
}) => {
  return (
    <Modal
      animationType="fade"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.body}>{children}</View>
          <View style={styles.actions}>
            <Pressable
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Dismiss dialog"
              onPress={onClose}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>OK</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 20,
    elevation: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 12,
  },
  body: {
    marginBottom: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0284C7',
  },
});
