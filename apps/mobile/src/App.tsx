import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './lib/auth';
import { DeviceProvider } from './lib/device-context';
import { useTheme } from './lib/theme';
import { RootNavigator } from './navigation/RootNavigator';

function ThemedNavigation() {
  const { palette, dark } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme: Theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.surface,
      text: palette.textPrimary,
      border: palette.border,
    },
  };
  return (
    <NavigationContainer theme={theme}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return <AppRoot />;
}

/** The app with all its providers. Tests pass their own query client (without clean-up timers). */
export function AppRoot({ queryClient: given }: { queryClient?: QueryClient }) {
  const [queryClient] = useState(() => given ?? new QueryClient());
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DeviceProvider>
            <ThemedNavigation />
          </DeviceProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
