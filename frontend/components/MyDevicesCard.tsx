import React, { useEffect, useState } from 'react';
import { Card, SectionTitle } from './ui';
import { authService } from '../services/authService';
import { DeviceList, deviceCountText, type DeviceInfo } from './DeviceList';

/** Profile card: the devices you're signed in on, and your limit. */
export const MyDevicesCard: React.FC = () => {
    const [data, setData] = useState<{ limit: number | null; devices: DeviceInfo[] } | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        authService.getMyDevices()
            .then(result => { if (!cancelled) setData(result); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, []);

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
                    </p>
                    <DeviceList devices={data.devices} />
                </>
            )}
        </Card>
    );
};
