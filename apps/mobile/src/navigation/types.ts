import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

/** Screens above the tabs. A class opens on its own screen from any tab. */
export type RootStackParamList = {
  Main: undefined;
  Class: { id: string };
  CheckClassroom: undefined;
  Survey: undefined;
  AttendanceCode: { attendanceSessionId: string };
  StudentId: undefined;
  CheckId: undefined;
  CourseAttendance: { offeringId: string };
  DisputeForm: { classSessionId: string; title: string; status: string };
  ExcuseForm: undefined;
  MyRequests: undefined;
  RequestDetail: { kind: 'dispute' | 'excuse'; id: string; notice?: string };
  Announcements: undefined;
  AnnouncementCompose: undefined;
  TwoStep: undefined;
  Login: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
