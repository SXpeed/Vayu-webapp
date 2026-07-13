import { useState, useEffect, useRef, useCallback } from 'react';
import { UserProfile } from '../types';
import { authService, AuthUser } from '../services/authService';
import { db } from '../services/db';

/**
 * Manages auth state: authUser, userProfile, theme, and the
 * presence heartbeat effect (30s interval + beforeunload offline mark).
 */
export function useAuth() {
    const [authUser, setAuthUser] = useState<AuthUser | null>(null);
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [theme, setTheme] = useState<'light' | 'dark'>('light');

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
            phone: '',
            address: '',
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

    // Presence heartbeat: ping every 30 seconds + mark offline on unload
    useEffect(() => {
        if (!authUser) return;
        let cancelled = false;

        const beat = async () => {
            if (cancelled) return;
            try { await authService.heartbeat(); } catch { /* silent */ }
        };
        beat();
        const interval = setInterval(beat, 30000);

        const onUnload = () => { authService.setOffline(); };
        window.addEventListener('beforeunload', onUnload);

        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('beforeunload', onUnload);
            authService.setOffline();
        };
    }, [authUser]);

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