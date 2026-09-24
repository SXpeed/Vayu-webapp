import { useState, useEffect, useRef, useCallback } from 'react';
import { UserProfile } from '../types';
import { authService, AuthUser } from '../services/authService';
import { db } from '../services/db';
import toast from 'react-hot-toast';
import { createRefreshScheduler } from '../services/refreshScheduler';
import { realtimeService } from '../services/realtimeService';

/**
 * Manages auth state: authUser, userProfile, theme, and the
 * visible-tab presence refresh (five-minute interval).
 */
export function useAuth() {
    const [authUser, setAuthUser] = useState<AuthUser | null>(null);
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    // Starts from the saved theme, not 'light': the effect below runs on mount,
    // and a 'light' start stripped the dark class index.html had set — so the
    // loading screen flashed light for anyone on the dark theme.
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        try { return localStorage.getItem('vayu_theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
    });

    // Ref to access current authUser inside callbacks without adding it as a dependency
    const authUserRef = useRef<AuthUser | null>(null);

    // Apply theme to <html>
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    const applyAuthUser = useCallback((user: AuthUser) => {
        authUserRef.current = user;
        setAuthUser(user);
        const savedTheme = (localStorage.getItem('vayu_theme') as 'light' | 'dark') || 'light';
        const profile: UserProfile = {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone ?? '',
            address: user.address ?? '',
            theme: savedTheme,
        };
        setUserProfile(profile);
        setTheme(savedTheme);
    }, []);

    const clearAuth = useCallback(() => {
        authUserRef.current = null;
        setAuthUser(null);
        setUserProfile(null);
    }, []);

    const handleUpdateProfile = useCallback(async (updatedProfile: UserProfile) => {
        setUserProfile(updatedProfile);
        await db.saveUser(updatedProfile);

        // Name and contact details live on the server so they survive a reload
        // and teammates see the new name. Other profile toggles stay local.
        const current = authUserRef.current;
        if (!current) return;
        const unchanged = updatedProfile.name === current.name
            && updatedProfile.phone === (current.phone ?? '')
            && updatedProfile.address === (current.address ?? '');
        if (unchanged) return;
        try {
            const saved = await authService.updateMe({
                name: updatedProfile.name,
                phone: updatedProfile.phone,
                address: updatedProfile.address,
            });
            const merged: AuthUser = { ...current, ...saved };
            authUserRef.current = merged;
            setAuthUser(merged);
            setUserProfile(prev => (prev ? { ...prev, name: saved.name, phone: saved.phone ?? '', address: saved.address ?? '' } : prev));
        } catch (e) {
            console.error('Failed to save profile:', e);
            toast.error('Could not save your profile. Please try again.');
        }
    }, []);

    const handleToggleTheme = useCallback(async () => {
        const newTheme: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        localStorage.setItem('vayu_theme', newTheme);
        if (userProfile) {
            const updated = { ...userProfile, theme: newTheme };
            setUserProfile(updated);
            await db.saveUser(updated);
        }
    }, [theme, userProfile]);

    const handleLogout = useCallback(async (navigateTo: (view: any) => void) => {
        await authService.logout();
        clearAuth();
        navigateTo('login');
    }, [clearAuth]);

    // Photos and attachments load with a private 7-day file cookie (FILE_AUTH)
    // that /auth/me renews when it is missing or expired. /auth/me runs when
    // the app starts, but an installed app can stay suspended for longer than
    // a week, so ask again when it comes back after a long while (and hourly
    // while open). Cheap: the server only issues a cookie when one is needed.
    useEffect(() => {
        if (!authUser) return;
        let lastRenewal = Date.now();
        const renew = () => {
            if (document.visibilityState !== 'visible' || !navigator.onLine) return;
            if (Date.now() - lastRenewal < 6 * 3_600_000) return;
            lastRenewal = Date.now();
            authService.getMe().catch(() => { /* next time */ });
        };
        const timer = setInterval(renew, 3_600_000);
        document.addEventListener('visibilitychange', renew);
        window.addEventListener('online', renew);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', renew);
            window.removeEventListener('online', renew);
        };
    }, [authUser?.id]);

    // Presence is informational, not business-critical. A five-minute visible-
    // tab heartbeat avoids thousands of Worker invocations and KV writes per
    // employee while still providing a useful approximate online indicator.
    useEffect(() => {
        if (!authUser) return;
        const scheduler = createRefreshScheduler({
            // A live realtime socket IS presence (the hub reports it); the KV
            // heartbeat only feeds the fallback used when the hub is down.
            run: async () => { if (!realtimeService.connected) await authService.heartbeat(); },
            intervalMs: 5 * 60_000,
            enabled: () => document.visibilityState === 'visible' && navigator.onLine,
        });
        const onVisibilityChange = () => { void scheduler.request(); };
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('online', onVisibilityChange);

        return () => {
            scheduler.stop();
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('online', onVisibilityChange);
            // Let TTL expire: closing one tab must not mark another tab offline.
        };
    }, [authUser?.id]);

    return {
        authUser,
        authUserRef,
        userProfile,
        theme,
        setTheme,
        applyAuthUser,
        clearAuth,
        handleUpdateProfile,
        handleToggleTheme,
        handleLogout,
    };
}
