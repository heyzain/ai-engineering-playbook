import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/ui/button';
import { PlatformModal } from '../components/ui/modal';

export const HomeScreen: React.FC = () => {
  const [modalVisible, setModalVisible] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>AI Engineering Playbook</Text>
      <Text style={styles.subtitle}>React Native Foundation Stack</Text>

      <View style={styles.actionSection}>
        <Button
          label="Open Platform Modal"
          onPress={() => setModalVisible(true)}
        />
      </View>

      <PlatformModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        title="Platform Companion Modal"
      >
        <Text style={styles.modalText}>
          This modal resolves specialized platform companions (.ios.tsx and .android.tsx) symmetrically.
        </Text>
      </PlatformModal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#64748B',
    marginBottom: 32,
    textAlign: 'center',
  },
  actionSection: {
    width: '100%',
    alignItems: 'center',
  },
  modalText: {
    fontSize: 15,
    color: '#334155',
    lineHeight: 22,
  },
});
