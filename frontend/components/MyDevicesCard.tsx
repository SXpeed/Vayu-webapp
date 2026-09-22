import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { LogOut } from 'lucide-react';
import { Button, Card, SectionTitle } from './ui';
import { authService } from '../services/authService';
import { DeviceList, deviceCountText, type DeviceInfo } from './DeviceList';

/**
 * Profile card: the devices you're signed in on and your limit, with
 * sign-out for any other device (e.g. a lost phone) or all of them at once.
 */
export const MyDevicesCard: React.FC = () => {
    const [data, setData] = useState<{ limit: number | null; devices: DeviceInfo[] } | null>(null);
    const [failed, setFailed] = useState(false);
    /** Device id being signed out, or 'all'. */
    const [busyId, setBusyId] = useState<string | null>(null);
    const [confirmAll, setConfirmAll] = useState(false);

    const load = useCallback(async () => {
        try {
            setData(await authService.getMyDevices());
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    // "Sign out all" asks for a second tap; the question lapses after a few seconds.
    useEffect(() => {
        if (!confirmAll) return;
        const timer = setTimeout(() => setConfirmAll(false), 5000);
        return () => clearTimeout(timer);
    }, [confirmAll]);

    const signOutOne = async (device: DeviceInfo) => {
        if (!device.id) return;
        setBusyId(device.id);
        try {
            await authService.signOutDevice(device.id);
            toast.success(`Signed out ${device.label}`);
        } catch (e) {
            toast.error((e as Error).message || 'Could not sign that device out');
        } finally {
            setBusyId(null);
            void load();
        }
    };

    const signOutOthers = async () => {
        if (!confirmAll) { setConfirmAll(true); return; }
        setConfirmAll(false);
        setBusyId('all');
        try {
            const count = await authService.signOutOtherDevices();
            toast.success(count === 1 ? 'Signed out 1 other device' : `Signed out ${count} other devices`);
        } catch (e) {
            toast.error((e as Error).message || 'Could not sign out your other devices');
        } finally {
            setBusyId(null);
            void load();
        }
    };

    const others = data ? data.devices.filter(d => !d.current).length : 0;
    const othersText = others === 1 ? '1 device' : `${others} devices`;
    let signOutAllLabel = 'Sign out all other devices';
    if (busyId === 'all') signOutAllLabel = 'Signing out…';
    else if (confirmAll) signOutAllLabel = `Tap again to sign out ${othersText}`;

    return (
        <Card padding="lg" className="animate-fade-in-up space-y-3">
            <SectionTitle>Signed-in devices</SectionTitle>
            {failed && <p className="text-[11px] text-[var(--neu-text-dim)]">Couldn't load your devices right now.</p>}
            {!failed && !data && <p className="text-[11px] text-[var(--neu-text-dim)]">Loading…</p>}
            {data && (
                <>
                    <p className="text-xs text-[var(--neu-text-dim)] leading-relaxed">
                        You're signed in on {deviceCountText(data.devices.length, data.limit)}.
                        {data.limit
                            ? ' Signing in on another device signs out the one used longest ago.'
                            : ' Admins can sign in on any number of devices.'}
                        {others > 0 && " Don't recognise one, or lost a phone? Sign it out."}
                    </p>
                    <DeviceList devices={data.devices} onSignOut={signOutOne} busyId={busyId} />
                    {others > 0 && (
                        <Button
                            variant="danger"
                            block
                            onClick={signOutOthers}
                            disabled={busyId !== null}
                            icon={<LogOut size={14} />}
                        >
                            {signOutAllLabel}
                        </Button>
                    )}
                </>
            )}
        </Card>
    );
};
