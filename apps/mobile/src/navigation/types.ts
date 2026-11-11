import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

/** Screens above the tabs. A class opens on its own screen from any tab. */
export type RootStackParamList = {
  Main: undefined;
  Class: { id: string };
  CheckClassroom: undefined;
  Survey: undefined;
  TwoStep: undefined;
  Login: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
