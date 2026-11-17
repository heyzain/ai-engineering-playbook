import React from 'react';
import { Modal, StyleSheet, Text, View, Pressable } from 'react-native';

export interface PlatformModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  children?: React.ReactNode;
}

/**
 * iOS-specialized platform modal.
 * Uses native slide presentation style standard on iOS.
 */
export const PlatformModal: React.FC<PlatformModalProps> = ({
  visible,
  onClose,
  title,
  children,
}) => {
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      transparent={false}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Close modal"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>
        <View style={styles.body}>{children}</View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
  },
  closeButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    fontSize: 16,
    color: '#0284C7',
    fontWeight: '600',
  },
  body: {
    flex: 1,
    paddingTop: 16,
  },
});
