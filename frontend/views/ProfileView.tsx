import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserProfile } from '../types';
import { Moon, Sun, LogOut, Check, Bell, BellOff, Pencil, X, Type, Image as ImageIcon, Palette, Contrast } from 'lucide-react';
import { pushService } from '../services/pushService';
import { MyDevicesCard } from '../components/MyDevicesCard';
import { EmailCard, PasswordCard, WorkspaceCard } from '../components/AccountCards';
import { getUiSize, setUiSize, type UiSize } from '../uiSize';
import { TILE_BACKDROPS, getTileBackdrop, setTileBackdrop, type TileBackdrop } from '../tileBackdrop';
import { APP_STYLES, getAppStyle, setAppStyle, getOled, setOled, type AppStyle } from '../appStyle';
import {
    PageRoot, PageHeader, PageBody, Card, SectionTitle, Field, Input, Textarea,
    ReadOnlyValue, ToggleRow, Button, Divider, Pill,
} from '../components/ui';

interface ProfileViewProps {
    profile: UserProfile;
    onUpdateProfile: (profile: UserProfile) => void;
    theme: 'light' | 'dark';
    onToggleTheme: () => void;
    onLogout: () => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({ profile, onUpdateProfile, theme, onToggleTheme, onLogout }) => {
    const [formData, setFormData] = useState<UserProfile>(profile);
    const [isEditing, setIsEditing] = useState(false);

    // ── Push notifications ──────────────────────────────────────────────
    const pushSupported = pushService.isSupported();
    const [pushEnabled, setPushEnabled] = useState(false);
    const [pushBusy, setPushBusy] = useState(false);

    useEffect(() => {
        pushService.isEnabled().then(setPushEnabled).catch(() => setPushEnabled(false));
    }, []);

    const handleTogglePush = async () => {
        if (pushBusy) return;
        if (!pushSupported) {
            toast.error('Notifications are not supported in this browser');
            return;
        }
        setPushBusy(true);
        try {
            if (pushEnabled) {
                await pushService.disable();
                setPushEnabled(false);
                toast('Notifications turned off');
            } else {
                await pushService.enable();
                setPushEnabled(true);
                toast.success('Notifications turned on');
            }
        } catch (e) {
            toast.error((e as Error).message || 'Could not update notification settings');
        } finally {
            setPushBusy(false);
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = () => {
        onUpdateProfile(formData);
        setIsEditing(false);
    };

    const startEditing = () => {
        setFormData(profile);
        setIsEditing(true);
    };

    return (
        <PageRoot width="narrow">
            <PageHeader
                title="Profile"
                subtitle={profile.email}
                actions={isEditing ? (
                    <>
                        <Button onClick={() => setIsEditing(false)} icon={<X size={14} />}>Cancel</Button>
                        <Button variant="primary" onClick={handleSave} icon={<Check size={14} />}>Save</Button>
                    </>
                ) : (
                    <Button onClick={startEditing} icon={<Pencil size={14} />}>Edit</Button>
                )}
            />

            <PageBody space="lg">
                {/* Personal Info */}
                <Card padding="lg" className="animate-fade-in-up space-y-4">
                    <SectionTitle>Personal Details</SectionTitle>

                    <Field label="Full Name" htmlFor="profile-name">
                        {isEditing
                            ? <Input id="profile-name" name="name" value={formData.name} onChange={handleChange} />
                            : <ReadOnlyValue className="font-serif text-base">{profile.name}</ReadOnlyValue>}
                    </Field>

                    {/* Email is the login, so only admins can change it (User Management). */}
                    <Field label="Email Address" hint={isEditing ? 'Ask an admin to change your email.' : undefined}>
                        <ReadOnlyValue>{profile.email}</ReadOnlyValue>
                    </Field>

                    <Field label="Phone Number" htmlFor="profile-phone">
                        {isEditing
                            ? <Input id="profile-phone" type="tel" name="phone" value={formData.phone} onChange={handleChange} />
                            : <ReadOnlyValue>{profile.phone}</ReadOnlyValue>}
                    </Field>

                    <Field label="Address" htmlFor="profile-address">
                        {isEditing
                            ? <Textarea id="profile-address" name="address" value={formData.address} onChange={handleChange} rows={2} />
                            : <ReadOnlyValue>{profile.address}</ReadOnlyValue>}
                    </Field>
                </Card>

                {/* App Settings */}
                <Card padding="lg" className="animate-fade-in-up space-y-1">
                    <SectionTitle>App Settings</SectionTitle>

                    <ToggleRow
                        icon={theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
                        title="Dark Mode"
                        checked={theme === 'dark'}
                        onChange={onToggleTheme}
                    />

                    {theme === 'dark' && <OledRow />}

                    <Divider />

                    <AppStyleRow />

                    <Divider />

                    <UiSizeRow />

                    <Divider />

                    <TileBackdropRow />

                    <Divider />

                    <ToggleRow
                        icon={pushEnabled ? <Bell size={18} /> : <BellOff size={18} />}
                        title="Notifications"
                        description={pushSupported ? undefined : 'Not supported in this browser'}
                        checked={pushEnabled}
                        onChange={handleTogglePush}
                        disabled={!pushSupported || pushBusy}
                    />

                    <Divider />

                    <ToggleRow
                        icon={
                            <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center ${profile.isOnline ? 'bg-green-500' : 'bg-gray-400'}`}>
                                <span className="w-2 h-2 bg-white rounded-full" />
                            </span>
                        }
                        title={profile.isOnline ? 'Online' : 'Offline'}
                        checked={!!profile.isOnline}
                        onChange={() => onUpdateProfile({ ...profile, isOnline: !profile.isOnline })}
                    />
                </Card>

                <WorkspaceCard />
                <EmailCard />
                <PasswordCard />
                <MyDevicesCard />

                {/* Logout */}
                <Button
                    variant="danger"
                    block
                    onClick={onLogout}
                    icon={<LogOut size={16} />}
                    className="uppercase tracking-wider animate-fade-in-up"
                >
                    Sign Out
                </Button>
            </PageBody>
        </PageRoot>
    );
};

/** The backdrop behind product photos in tiles: six swatches on one line, this device only. */
const TileBackdropRow: React.FC = () => {
    const [value, setValue] = useState<TileBackdrop>(getTileBackdrop);
    const choose = (next: TileBackdrop) => {
        setTileBackdrop(next);
        setValue(next);
    };
    const current = TILE_BACKDROPS.find(o => o.value === value)?.label;
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
            <div className="flex items-center gap-3 min-w-0 text-gray-700 dark:text-gray-200">
                <ImageIcon size={18} className="shrink-0" />
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">Product tile background</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light">{current} · On this device</p>
                </div>
            </div>
            <div role="radiogroup" aria-label="Product tile background" className="flex gap-2 shrink-0">
                {TILE_BACKDROPS.map(o => {
                    const on = value === o.value;
                    return (
                        <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={o.label}
                            title={o.label}
                            onClick={() => choose(o.value)}
                            className={`w-8 h-8 rounded-full p-[3px] active-scale ${on ? 'ring-2 ring-gold-500 dark:ring-gold-400' : 'neu-raised-sm'}`}
                        >
                            <span data-tile-bg={o.value} className="tile-backdrop block w-full h-full rounded-full" />
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

/** Pure black dark mode for OLED screens — this device only, like the theme. */
const OledRow: React.FC = () => {
    const [on, setOn] = useState(getOled);
    return (
        <ToggleRow
            icon={<Contrast size={18} />}
            title="Pure black (OLED)"
            description="Saves battery on OLED screens · On this device"
            checked={on}
            onChange={() => { setOled(!on); setOn(!on); }}
        />
    );
};

/** Classic (soft UI), Atelier (flat warm surfaces and motion) or Lite (flat, no motion: lightest on phones) — this device only, like the theme. */
const AppStyleRow: React.FC = () => {
    const [style, setStyle] = useState<AppStyle>(getAppStyle);
    const choose = (next: AppStyle) => {
        setAppStyle(next);
        setStyle(next);
    };
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
            <div className="flex items-center gap-3 min-w-0 text-gray-700 dark:text-gray-200">
                <Palette size={18} className="shrink-0" />
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">App style</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light">Same layout, different look · On this device</p>
                </div>
            </div>
            <fieldset aria-label="App style" className="flex gap-2 shrink-0">
                {APP_STYLES.map(o => (
                    <Pill key={o.value} active={style === o.value} onClick={() => choose(o.value)}>{o.label}</Pill>
                ))}
            </fieldset>
        </div>
    );
};

const UI_SIZES: { value: UiSize; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large' },
];

/** Small (90%), Default (95%) or Large (100%) — this device only, like the theme. */
const UiSizeRow: React.FC = () => {
    const [size, setSize] = useState<UiSize>(getUiSize);
    const choose = (next: UiSize) => {
        setUiSize(next);
        setSize(next);
    };
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
            <div className="flex items-center gap-3 min-w-0 text-gray-700 dark:text-gray-200">
                <Type size={18} className="shrink-0" />
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">UI Size</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light">On this device</p>
                </div>
            </div>
            <fieldset aria-label="UI size" className="flex gap-2 shrink-0">
                {UI_SIZES.map(o => (
                    <Pill key={o.value} active={size === o.value} onClick={() => choose(o.value)}>{o.label}</Pill>
                ))}
            </fieldset>
        </div>
    );
};
