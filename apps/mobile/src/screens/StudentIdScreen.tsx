import { useQuery } from '@tanstack/react-query';
import { Image, Text, useWindowDimensions, View } from 'react-native';
import { Pill, QrCode } from '../components/phase6';
import { BodyText, Card, Notice, Screen } from '../components/ui';
import { ApiError, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

interface IdCard {
  student: {
    fullName: string;
    studentNumber: string;
    programme: { name: string };
    level: { name: string } | null;
    status: string;
    hasPhoto: boolean;
  };
  code: { value: string; expiresAt: string; refreshAfterSeconds: number };
}

/**
 * The digital student ID (Phase 6 step 5). The code comes from the server and is asked for again every
 * 30 seconds; when the phone is offline the card stays but the code is hidden (a code shown offline
 * could be copied and used later).
 */
export function StudentIdScreen() {
  const { call } = useAuth();
  const { palette, spacing, radius } = useTheme();
  const { width } = useWindowDimensions();
  const card = useQuery({
    queryKey: ['student-id'],
    queryFn: () => call<IdCard>('/me/student-id'),
    refetchInterval: (q) => (q.state.data?.code.refreshAfterSeconds ?? 30) * 1000,
    gcTime: 0,
  });
  const photo = useQuery({
    queryKey: ['student-id-photo'],
    enabled: card.data?.student.hasPhoto === true,
    queryFn: () => call<{ url: string }>('/me/student-id/photo'),
    staleTime: 4 * 60_000,
  });
  const offline = card.error instanceof ApiError && card.error.code === 'NETWORK_ERROR';
  const s = card.data?.student;
  // The last code is shown only while it is still valid and the latest refresh worked.
  const codeIsCurrent = !!card.data && !card.isError && Date.parse(card.data.code.expiresAt) > Date.now();

  return (
    <Screen>
      {card.isPending ? <BodyText muted>Loading your card…</BodyText> : null}
      {card.isError && !card.data ? (
        <Notice tone="error">
          {offline ? 'Connect to the internet to show your student ID.' : describeError(card.error)}
        </Notice>
      ) : null}
      {s ? (
        <View
          style={{
            borderRadius: radius.sheet,
            overflow: 'hidden',
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.border,
          }}
        >
          <View style={{ backgroundColor: palette.primary, padding: spacing[4] }}>
            <Text style={{ color: palette.onPrimary, fontWeight: '600', fontSize: 15 }}>
              Knutsford University
            </Text>
            <Text style={{ color: palette.onPrimary, fontSize: 12 }}>Student identity · AttendSure</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: spacing[4], padding: spacing[4] }}>
            {photo.data ? (
              <Image
                source={{ uri: photo.data.url }}
                style={{ width: 84, height: 104, borderRadius: radius.control }}
                accessibilityLabel="Your photo"
              />
            ) : (
              <View
                style={{
                  width: 84,
                  height: 104,
                  borderRadius: radius.control,
                  backgroundColor: palette.primaryTint,
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 4,
                }}
              >
                <Text style={{ color: palette.primary, fontSize: 11, textAlign: 'center' }}>
                  No photo on record
                </Text>
              </View>
            )}
            <View style={{ flex: 1, gap: 8 }}>
              <Field label="Name" value={s.fullName} />
              <Field label="Student ID" value={s.studentNumber} />
              <Field label="Programme" value={`${s.programme.name}${s.level ? ` · ${s.level.name}` : ''}`} />
            </View>
          </View>
          <View style={{ paddingHorizontal: spacing[4], paddingBottom: spacing[3] }}>
            <Pill
              label={s.status === 'ACTIVE' ? 'Active student' : `Status: ${s.status.toLowerCase()}`}
              tone={s.status === 'ACTIVE' ? 'success' : 'error'}
            />
          </View>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: palette.borderSubtle,
              padding: spacing[4],
              alignItems: 'center',
              gap: 8,
            }}
          >
            {codeIsCurrent ? (
              <>
                <QrCode
                  value={card.data!.code.value}
                  size={Math.min(width - 120, 220)}
                  label="Your student ID code"
                />
                <BodyText muted>The code changes every 30 seconds.</BodyText>
              </>
            ) : (
              <Notice tone="info">Connect to the internet to show your ID code.</Notice>
            )}
          </View>
        </View>
      ) : null}
      <Card>
        <BodyText muted>
          Staff scan this code to confirm who you are. It holds no personal details, and each check is
          recorded.
        </BodyText>
      </Card>
    </Screen>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const { palette } = useTheme();
  return (
    <View>
      <Text style={{ color: palette.textMuted, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: palette.textPrimary, fontSize: 15, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}
