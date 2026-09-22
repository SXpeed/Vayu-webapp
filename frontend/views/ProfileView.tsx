import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { UserProfile } from '../types';
import { Moon, Sun, LogOut, Check, Bell, BellOff, Pencil, X } from 'lucide-react';
import { pushService } from '../services/pushService';
import { MyDevicesCard } from '../components/MyDevicesCard';
import {
    PageRoot, PageHeader, PageBody, Card, SectionTitle, Field, Input, Textarea,
    ReadOnlyValue, ToggleRow, Button, Divider,
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
