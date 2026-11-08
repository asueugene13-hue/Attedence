import { ROLE_LABELS } from '@attendsure/shared';
import { BodyText, Card, Heading, Notice, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { WEB_DASHBOARD_ROLES } from '../navigation/tabs';

/** What each role will find here as the phases are completed (design canvas: information architecture). */
const COMING: Partial<Record<string, string>> = {
  STUDENT: 'Your next class, check-in, today’s timetable and your attendance will appear here.',
  COURSE_REP: 'Your next class, check-in, today’s timetable and your course-rep tools will appear here.',
  LECTURER: 'Your current or next class, with Start class and live attendance, will appear here.',
};

export function HomeScreen() {
  const { me } = useAuth();
  if (!me) return null;
  const role = me.activeRole;

  return (
    <Screen>
      <Heading subtitle={`Signed in as ${ROLE_LABELS[role]}`}>{`Hello, ${me.user.fullName}`}</Heading>
      {WEB_DASHBOARD_ROLES.includes(role) ? (
        <Notice tone="info">
          {ROLE_LABELS[role]} tools are on the AttendSure web dashboard. If you also teach or study, switch
          role in Profile.
        </Notice>
      ) : (
        <Card>
          <BodyText>{COMING[role] ?? ''}</BodyText>
          <BodyText muted>
            AttendSure is being built in phases; this screen fills in as each one is completed.
          </BodyText>
        </Card>
      )}
    </Screen>
  );
}
