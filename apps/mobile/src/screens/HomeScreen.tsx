import { ROLE_LABELS } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ClassCard } from '../components/class-card';
import { Pill, RowLink } from '../components/phase6';
import { BodyText, Button, Card, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type ClassSession, localDay } from '../lib/classes';
import {
  classWhen,
  type Dispute,
  EXCUSE_CATEGORY_LABELS,
  type Excuse,
  REQUEST_STATUS,
} from '../lib/requests';
import { useTheme } from '../lib/theme';
import { WEB_DASHBOARD_ROLES } from '../navigation/tabs';
import type { RootNavigation } from '../navigation/types';
import type { FeedItem } from './AnnouncementsScreen';

interface CourseLine {
  offeringId: string;
  course: { code: string; title: string };
  eligible: number;
  present: number;
  late: number;
  excused: number;
  percentage: number | null;
}
interface LecturerDashboard {
  waiting: {
    disputes: { count: number };
    checkIns: number;
    corrections: { waiting: number; answeredThisWeek: number };
  };
  excusedThisWeek: number;
  sections: {
    sectionId: string;
    code: string;
    course: { code: string };
    students: number;
    classesHeld: number;
    percentage: number | null;
  }[];
}

/**
 * Home (Phase 6, as on the design canvas). Students: today's classes, their open requests, the latest
 * announcements and attendance per course. Lecturers: what waits for them, today's classes and their
 * sections. Every number comes from the server; staff who work on the web are pointed there.
 */
export function HomeScreen() {
  const { me, call } = useAuth();
  const navigation = useNavigation<RootNavigation>();
  const { palette, spacing } = useTheme();
  const today = localDay();
  const role = me?.activeRole;
  const isStudent = role === 'STUDENT' || role === 'COURSE_REP';
  const isLecturer = role === 'LECTURER';
  const classes = useQuery({
    queryKey: ['my-timetable', today, today],
    enabled: isStudent || isLecturer,
    queryFn: () => call<{ data: ClassSession[] }>(`/me/timetable?from=${today}&to=${today}`),
    refetchInterval: 60_000,
  });
  const requests = useQuery({
    queryKey: ['my-requests', 'open'],
    enabled: isStudent,
    queryFn: async () => {
      const [d, e] = await Promise.all([
        call<{ data: Dispute[] }>('/disputes?state=OPEN'),
        call<{ data: Excuse[] }>('/excuse-requests?state=OPEN'),
      ]);
      return { disputes: d.data, excuses: e.data };
    },
  });
  const announcements = useQuery({
    queryKey: ['announcements', 'home'],
    enabled: isStudent,
    queryFn: () => call<{ data: FeedItem[] }>('/me/announcements?limit=2'),
  });
  const attendance = useQuery({
    queryKey: ['my-attendance'],
    enabled: isStudent,
    queryFn: () => call<{ data: CourseLine[]; minimumPercent: number | null }>('/me/attendance'),
  });
  const dashboard = useQuery({
    queryKey: ['lecturer-dashboard'],
    enabled: isLecturer,
    queryFn: () => call<LecturerDashboard>('/me/lecturer-dashboard'),
    refetchInterval: 60_000,
  });
  const repTargets = useQuery({
    queryKey: ['announcement-targets'],
    enabled: isStudent,
    queryFn: () => call<{ sections: unknown[] }>('/announcements/targets'),
  });
  if (!me || !role) return null;
  const refreshing = classes.isFetching || requests.isFetching || dashboard.isFetching;
  const refresh = () => {
    void classes.refetch();
    if (isStudent) {
      void requests.refetch();
      void announcements.refetch();
      void attendance.refetch();
    }
    if (isLecturer) void dashboard.refetch();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[5] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <Heading subtitle={`Signed in as ${ROLE_LABELS[role]}`}>{`Hello, ${me.user.fullName}`}</Heading>
        {WEB_DASHBOARD_ROLES.includes(role) ? (
          <>
            <Notice tone="info">
              {ROLE_LABELS[role]} tools are on the AttendSure web dashboard. If you also teach or study,
              switch role in Profile.
            </Notice>
            <Button
              label="Check a student ID"
              variant="secondary"
              onPress={() => navigation.navigate('CheckId')}
            />
          </>
        ) : null}

        {isStudent ? (
          <Button
            label="My student ID"
            variant="secondary"
            onPress={() => navigation.navigate('StudentId')}
          />
        ) : null}
        {isStudent && (repTargets.data?.sections.length ?? 0) > 0 ? (
          <Button
            label="Post a course-rep update"
            variant="secondary"
            onPress={() => navigation.navigate('AnnouncementCompose')}
          />
        ) : null}

        {isLecturer && dashboard.data ? (
          <Card>
            <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 16 }}>
              Waiting for you
            </Text>
            <Waiting
              count={dashboard.data.waiting.disputes.count}
              label="Disputes to decide"
              detail="Decide them on the web dashboard, under Reviews."
            />
            <Waiting
              count={dashboard.data.waiting.checkIns}
              label="Check-ins waiting"
              detail="Open the class to approve or reject them."
            />
            <Waiting
              count={dashboard.data.waiting.corrections.waiting}
              label="Late corrections waiting for an administrator"
            />
            {dashboard.data.waiting.disputes.count +
              dashboard.data.waiting.checkIns +
              dashboard.data.waiting.corrections.waiting ===
            0 ? (
              <BodyText muted>Nothing is waiting for you.</BodyText>
            ) : null}
          </Card>
        ) : null}
        {isLecturer && dashboard.isError ? (
          <Notice tone="error">{describeError(dashboard.error)}</Notice>
        ) : null}

        {isStudent || isLecturer ? (
          <View style={{ gap: spacing[3] }}>
            <BodyText>Today</BodyText>
            {classes.isError ? <Notice tone="error">{describeError(classes.error)}</Notice> : null}
            {classes.data?.data.length === 0 ? <BodyText muted>No classes today.</BodyText> : null}
            {classes.data?.data.map((s) => (
              <ClassCard key={s.id} session={s} onPress={() => navigation.navigate('Class', { id: s.id })} />
            ))}
          </View>
        ) : null}

        {isStudent && requests.data && requests.data.disputes.length + requests.data.excuses.length > 0 ? (
          <Card>
            <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 16 }}>Your requests</Text>
            {requests.data.disputes.map((d) => (
              <RowLink
                key={d.id}
                title={`Dispute · ${d.class?.course?.code ?? 'Class'} ${classWhen(d.class?.scheduledStart ?? null)}`}
                onPress={() => navigation.navigate('RequestDetail', { kind: 'dispute', id: d.id })}
              >
                <Pill label={REQUEST_STATUS[d.status].label} tone={REQUEST_STATUS[d.status].tone} />
              </RowLink>
            ))}
            {requests.data.excuses.map((e) => (
              <RowLink
                key={e.id}
                title={`Excuse · ${EXCUSE_CATEGORY_LABELS[e.category]}, ${e.classCount} class${e.classCount === 1 ? '' : 'es'}`}
                onPress={() => navigation.navigate('RequestDetail', { kind: 'excuse', id: e.id })}
              >
                <Pill label={REQUEST_STATUS[e.status].label} tone={REQUEST_STATUS[e.status].tone} />
              </RowLink>
            ))}
          </Card>
        ) : null}

        {isStudent ? (
          <View style={{ gap: spacing[3] }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <BodyText>Announcements</BodyText>
              <Button
                label="See all"
                variant="secondary"
                onPress={() => navigation.navigate('Announcements')}
              />
            </View>
            {announcements.data?.data.length === 0 ? <BodyText muted>No announcements yet.</BodyText> : null}
            {announcements.data?.data.map((a) => (
              <Card key={a.id}>
                <Text
                  style={{
                    color: a.kind === 'OFFICIAL' ? palette.primary : palette.textSecondary,
                    fontSize: 12,
                    fontWeight: '600',
                  }}
                >
                  {`${a.read ? '' : '● '}${a.kind === 'OFFICIAL' ? 'Official' : 'Course rep'} · ${a.audience}`}
                </Text>
                <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>{a.title}</Text>
                <Text numberOfLines={2} style={{ color: palette.textSecondary, fontSize: 13 }}>
                  {a.body}
                </Text>
              </Card>
            ))}
          </View>
        ) : null}

        {isStudent && attendance.data ? (
          <Card>
            <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 16 }}>
              Attendance this semester
            </Text>
            {attendance.data.data.map((c) => (
              <View
                key={c.offeringId}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>{c.course.code}</Text>
                  <Text style={{ color: palette.textMuted, fontSize: 12 }}>
                    {c.eligible === 0
                      ? 'No classes counted yet'
                      : `${c.present + c.late} of ${c.eligible - c.excused} attended${c.late ? ` · ${c.late} late` : ''}${c.excused ? ` · ${c.excused} excused` : ''}`}
                  </Text>
                </View>
                <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 17 }}>
                  {c.percentage === null ? '—' : `${c.percentage}%`}
                </Text>
              </View>
            ))}
            <BodyText muted>
              {attendance.data.minimumPercent === null
                ? 'No minimum attendance set yet. Cancelled classes and approved excuses are not counted.'
                : `Minimum ${attendance.data.minimumPercent}%. Cancelled classes and approved excuses are not counted.`}
            </BodyText>
          </Card>
        ) : null}

        {isLecturer && dashboard.data && dashboard.data.sections.length > 0 ? (
          <Card>
            <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 16 }}>
              Attendance by section
            </Text>
            {dashboard.data.sections.map((s) => (
              <View
                key={s.sectionId}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}
              >
                <Text
                  style={{ flex: 1, color: palette.textPrimary, fontWeight: '600' }}
                >{`${s.course.code} · ${s.code}`}</Text>
                <Text style={{ color: palette.textMuted, fontSize: 12 }}>{`${s.classesHeld} held`}</Text>
                <Text
                  style={{
                    color: palette.textPrimary,
                    fontWeight: '600',
                    fontSize: 16,
                    width: 56,
                    textAlign: 'right',
                  }}
                >
                  {s.percentage === null ? '—' : `${s.percentage}%`}
                </Text>
              </View>
            ))}
          </Card>
        ) : null}
        {isLecturer ? (
          <View style={{ gap: spacing[3] }}>
            <Button
              label="Write an announcement"
              variant="secondary"
              onPress={() => navigation.navigate('AnnouncementCompose')}
            />
            <Button
              label="Check a student ID"
              variant="secondary"
              onPress={() => navigation.navigate('CheckId')}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Waiting({ count, label, detail }: { count: number; label: string; detail?: string }) {
  const { palette } = useTheme();
  if (count === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', minHeight: 44 }}>
      <View
        style={{
          minWidth: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: palette.warningBg,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 8,
        }}
      >
        <Text style={{ color: palette.warning, fontWeight: '600' }}>{count}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>{label}</Text>
        {detail ? <Text style={{ color: palette.textMuted, fontSize: 12 }}>{detail}</Text> : null}
      </View>
    </View>
  );
}
