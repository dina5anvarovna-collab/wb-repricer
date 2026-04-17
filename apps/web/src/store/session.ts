import { create } from "zustand";
import { persist } from "zustand/middleware";

type SessionState = {
  token: string | null;
  setToken: (t: string | null) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      setToken: (t) => set({ token: t }),
    }),
    { name: "wb-repricer-session" },
  ),
);
