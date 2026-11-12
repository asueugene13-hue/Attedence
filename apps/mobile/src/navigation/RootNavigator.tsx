import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { AlertsScreen } from '../screens/AlertsScreen';
import { AttendanceCodeScreen } from '../screens/AttendanceCodeScreen';
import { CheckInScreen } from '../screens/CheckInScreen';
import { CheckClassroomScreen } from '../screens/CheckClassroomScreen';
import { ClassScreen } from '../screens/ClassScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { MyAttendanceScreen } from '../screens/MyAttendanceScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { ScheduleScreen } from '../screens/ScheduleScreen';
import { SurveyScreen } from '../screens/SurveyScreen';
import { TwoStepScreen } from '../screens/TwoStepScreen';
import { type TabName, tabsForRole } from './tabs';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator();

const SCREENS: Record<TabName, () => React.JSX.Element | null> = {
  Home: HomeScreen,
  CheckIn: CheckInScreen,
  Attendance: MyAttendanceScreen,
  Schedule: ScheduleScreen,
  Alerts: AlertsScreen,
  Profile: ProfileScreen,
};
const LABELS: Record<TabName, string> = {
  Home: 'Home',
  CheckIn: 'Check in',
  Attendance: 'Attendance',
  Schedule: 'Schedule',
  Alerts: 'Alerts',
  Profile: 'Profile',
};
type IconName = ComponentProps<typeof Ionicons>['name'];
const ICONS: Record<TabName, [IconName, IconName]> = {
  Home: ['home', 'home-outline'],
  CheckIn: ['qr-code', 'qr-code-outline'],
  Attendance: ['stats-chart', 'stats-chart-outline'],
  Schedule: ['calendar', 'calendar-outline'],
  Alerts: ['notifications', 'notifications-outline'],
  Profile: ['person-circle', 'person-circle-outline'],
};

function SignedInTabs() {
  const { me, call } = useAuth();
  const { palette } = useTheme();
  const tabs = tabsForRole(me!.activeRole);
  const unread = useQuery({
    queryKey: ['unread-count'],
    queryFn: () => call<{ unread: number }>('/me/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarLabel: LABELS[route.name as TabName],
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.border },
        tabBarIcon: ({ focused, color, size }) => (
          <Ionicons name={ICONS[route.name as TabName][focused ? 0 : 1]} size={size} color={color} />
        ),
      })}
    >
      {tabs.map((name) => (
        <Tabs.Screen
          key={name}
          name={name}
          component={SCREENS[name]}
          options={name === 'Alerts' && unread.data?.unread ? { tabBarBadge: unread.data.unread } : undefined}
        />
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
        <>
          <Stack.Screen name="Main" component={SignedInTabs} />
          <Stack.Screen
            name="Class"
            component={ClassScreen}
            options={{ headerShown: true, title: 'Class' }}
          />
          <Stack.Screen
            name="AttendanceCode"
            component={AttendanceCodeScreen}
            options={{ headerShown: true, title: 'Attendance code' }}
          />
          <Stack.Screen
            name="CheckClassroom"
            component={CheckClassroomScreen}
            options={{ headerShown: true, title: 'Check this classroom' }}
          />
          {auth.me.permissions.includes('beacons.manage') ? (
            <Stack.Screen
              name="Survey"
              component={SurveyScreen}
              options={{ headerShown: true, title: 'Beacon survey' }}
            />
          ) : null}
        </>
      ) : auth.pendingMfa ? (
        <Stack.Screen name="TwoStep" component={TwoStepScreen} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}
