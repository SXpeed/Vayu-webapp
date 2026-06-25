import React, { useState } from 'react';
import { UserProfile } from '../types';
import { db } from '../services/db';

interface LoginViewProps {
    onLogin: (user: UserProfile) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
    const [isRegistering, setIsRegistering] = useState(false);
    const [phone, setPhone] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!phone || !password) {
            setError('Phone number and password are required.');
            return;
        }

        if (isRegistering) {
            if (!name) {
                setError('Name is required for registration.');
                return;
            }
            const existingUser = await db.getUser(phone);
            if (existingUser) {
                setError('User with this phone number already exists.');
                return;
            }
            const newUser: UserProfile = {
                id: `user_${Date.now()}`,
                name,
                email: '', // Optional now
                phone,
                address: '',
                password,
                theme: 'light'
            };
            await db.saveUser(newUser);
            onLogin(newUser);
        } else {
            const user = await db.getUser(phone);
            if (!user || user.password !== password) {
                setError('Invalid phone number or password.');
                return;
            }
            onLogin(user);
        }
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] items-center justify-center p-6 transition-colors duration-500 animate-fade-in">
            <div className="w-full max-w-sm space-y-10">
                <div className="text-center space-y-1 animate-fade-in-up">
                    <h1 className="text-5xl font-serif text-gold-500 tracking-wide">Vayu</h1>
                    <h2 className="text-lg font-serif text-gold-400 tracking-widest uppercase">Design for living</h2>
                </div>
                
                <form onSubmit={handleSubmit} className="space-y-6 bg-white dark:bg-[#1e1e1e] p-8 rounded-[7px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="text-center mb-6">
                        <h2 className="text-lg font-serif text-gray-800 dark:text-gray-200">
                            {isRegistering ? 'Create Account' : 'Welcome Back'}
                        </h2>
                    </div>

                    {error && (
                        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-[7px] text-xs text-center">
                            {error}
                        </div>
                    )}

                    {isRegistering && (
                        <div className="animate-fade-in">
                            <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Full Name</label>
                            <input 
                                type="text" 
                                value={name} 
                                onChange={e => setName(e.target.value)} 
                                className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors" 
                                placeholder="Jane Doe" 
                            />
                        </div>
                    )}

                    <div>
                        <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Phone Number</label>
                        <input 
                            type="tel" 
                            value={phone} 
                            onChange={e => setPhone(e.target.value)} 
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors" 
                            placeholder="+91 98765 43210" 
                        />
                    </div>
                    
                    <div>
                        <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider">Password</label>
                        <input 
                            type="password" 
                            value={password} 
                            onChange={e => setPassword(e.target.value)} 
                            className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-400 transition-colors" 
                            placeholder="••••••••" 
                        />
                    </div>
                    
                    <button 
                        type="submit" 
                        className="w-full bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[7px] py-3 text-sm font-medium tracking-wide hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors mt-8 shadow-md active-scale"
                    >
                        {isRegistering ? 'Sign Up' : 'Sign In'}
                    </button>

                    <div className="text-center mt-4">
                        <button 
                            type="button"
                            onClick={() => {
                                setIsRegistering(!isRegistering);
                                setError('');
                            }}
                            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors"
                        >
                            {isRegistering ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
