import React, { useState } from 'react';
import { UserProfile } from '../types';
import { ArrowLeft, Moon, Sun, LogOut, Check } from 'lucide-react';

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

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = () => {
        onUpdateProfile(formData);
        setIsEditing(false);
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-4 pt-8 pb-3 shadow-sm z-10 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center">
                <h1 className="text-xl font-serif text-gray-900 dark:text-white">Profile</h1>
                {isEditing ? (
                    <button onClick={handleSave} className="text-gold-600 dark:text-gold-400 font-medium text-xs uppercase tracking-wider flex items-center gap-1 active-scale">
                        <Check size={14} /> Save
                    </button>
                ) : (
                    <button onClick={() => setIsEditing(true)} className="text-brand-900 dark:text-gray-300 font-medium text-xs uppercase tracking-wider active-scale">
                        Edit
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar pb-24">
                
                {/* Personal Info */}
                <section className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3">Personal Details</h2>
                    
                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Full Name</label>
                        {isEditing ? (
                            <input 
                                name="name" value={formData.name} onChange={handleChange} 
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors" 
                            />
                        ) : (
                            <p className="text-gray-900 dark:text-white font-serif text-base py-1">{profile.name}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Email Address</label>
                        {isEditing ? (
                            <input 
                                type="email" name="email" value={formData.email} onChange={handleChange} 
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors" 
                            />
                        ) : (
                            <p className="text-gray-900 dark:text-gray-300 text-sm py-1">{profile.email}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Phone Number</label>
                        {isEditing ? (
                            <input 
                                type="tel" name="phone" value={formData.phone} onChange={handleChange} 
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors" 
                            />
                        ) : (
                            <p className="text-gray-900 dark:text-gray-300 text-sm py-1">{profile.phone}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Address</label>
                        {isEditing ? (
                            <textarea 
                                name="address" value={formData.address} onChange={handleChange} rows={2}
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors resize-none" 
                            />
                        ) : (
                            <p className="text-gray-900 dark:text-gray-300 text-sm py-1">{profile.address}</p>
                        )}
                    </div>
                </section>

                {/* App Settings */}
                <section className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-4 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3">App Settings</h2>
                    
                    <div className="flex justify-between items-center py-1">
                        <div className="flex items-center gap-3 text-gray-700 dark:text-gray-300">
                            {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
                            <span className="font-medium text-sm">Dark Mode</span>
                        </div>
                        <button 
                            onClick={onToggleTheme}
                            className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-300 ease-in-out active-scale ${theme === 'dark' ? 'bg-gold-500' : 'bg-gray-300'}`}
                        >
                            <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 ease-in-out ${theme === 'dark' ? 'translate-x-5' : 'translate-x-0'}`}></div>
                        </button>
                    </div>

                    <div className="w-full h-px bg-gray-100 dark:bg-gray-800"></div>

                    <div className="flex justify-between items-center py-1">
                        <div className="flex items-center gap-3 text-gray-700 dark:text-gray-300">
                            <div className={`w-[18px] h-[18px] rounded-full flex items-center justify-center ${profile.isOnline ? 'bg-green-500' : 'bg-gray-400'}`}>
                                <div className="w-2 h-2 bg-white rounded-full"></div>
                            </div>
                            <span className="font-medium text-sm">{profile.isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                        <button 
                            onClick={() => onUpdateProfile({ ...profile, isOnline: !profile.isOnline })}
                            className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-300 ease-in-out active-scale ${profile.isOnline ? 'bg-green-500' : 'bg-gray-300'}`}
                        >
                            <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 ease-in-out ${profile.isOnline ? 'translate-x-5' : 'translate-x-0'}`}></div>
                        </button>
                    </div>
                </section>

                {/* Logout */}
                <button 
                    onClick={onLogout}
                    className="w-full bg-white dark:bg-[#1e1e1e] border border-red-100 dark:border-red-900/30 text-red-600 dark:text-red-400 p-3.5 rounded-[7px] shadow-sm flex items-center justify-center gap-2 font-medium uppercase tracking-wider text-xs hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors active-scale animate-fade-in-up"
                    style={{ animationDelay: '150ms' }}
                >
                    <LogOut size={16} /> Sign Out
                </button>

            </div>
        </div>
    );
};
