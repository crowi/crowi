'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  image?: string;
  status: number;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function useAuth() {
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const fetchUser = useCallback(async () => {
    const accessToken = localStorage.getItem('accessToken');

    if (!accessToken) {
      setAuthState({
        user: null,
        isLoading: false,
        isAuthenticated: false,
      });
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/v2/auth/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setAuthState({
          user: data.user,
          isLoading: false,
          isAuthenticated: true,
        });
      } else {
        // Token is invalid, clear it
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        setAuthState({
          user: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    } catch (error) {
      setAuthState({
        user: null,
        isLoading: false,
        isAuthenticated: false,
      });
    }
  }, []);

  const logout = useCallback(async () => {
    const accessToken = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');

    // Call logout API if we have a token
    if (accessToken) {
      try {
        await fetch(`${API_BASE_URL}/api/v2/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      } catch (error) {
        // Ignore errors, we'll clear tokens anyway
      }
    }

    // Clear tokens
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');

    setAuthState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });

    router.push('/login');
  }, [router]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return {
    ...authState,
    logout,
    refetch: fetchUser,
  };
}
