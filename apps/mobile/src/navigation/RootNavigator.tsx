import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { TwoStepScreen } from '../screens/TwoStepScreen';
import { type TabName, tabsForRole } from './tabs';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const SCREENS: Record<TabName, () => React.JSX.Element | null> = { Home: HomeScreen, Profile: ProfileScreen };

function SignedInTabs() {
  const { me } = useAuth();
  const { palette } = useTheme();
  const tabs = tabsForRole(me!.activeRole);
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.border },
      }}
    >
      {tabs.map((name) => (
        <Tabs.Screen key={name} name={name} component={SCREENS[name]} />
      ))}
    </Tabs.Navigator>
  );
}

/** Which screens exist depends on sign-in state and the active role. */
export function RootNavigator() {
  const auth = useAuth();
  const { palette } = useTheme();

  if (auth.status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.background,
        }}
      >
        <ActivityIndicator accessibilityLabel="Checking your sign-in" color={palette.primary} />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {auth.status === 'signed-in' && auth.me ? (
        <Stack.Screen name="Main" component={SignedInTabs} />
      ) : auth.pendingMfa ? (
        <Stack.Screen name="TwoStep" component={TwoStepScreen} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}
