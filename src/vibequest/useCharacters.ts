import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/vibequest/supabase';
import robotPlayer from '@/assets/vibequest/robot-player.webp';
import robotMascot from '@/assets/vibequest/robot-mascot.webp';
import witchCat from '@/assets/vibequest/witch-cat-player.webp';
import capybara from '@/assets/vibequest/capybara-player.webp';

export interface Character {
  id: string;
  name: string;
  image_url: string;
  is_default: boolean;
}

/**
 * Bundled roster. The real list is the `characters` table in VibeQuest's own
 * Supabase (anybody can add one there). If that cannot be reached, the game
 * still has somebody to play as instead of an empty picker.
 */
export const LOCAL_CHARACTERS: Character[] = [
  { id: 'local-sky-explorer', name: 'Sky Explorer', image_url: robotPlayer, is_default: true },
  { id: 'local-vibe-guardian', name: 'Vibe Guardian', image_url: robotMascot, is_default: false },
  { id: 'local-witch-cat', name: 'Witch Cat', image_url: witchCat, is_default: false },
  { id: 'local-capybara', name: 'Capybara', image_url: capybara, is_default: false },
];

export const useCharacters = () => {
  return useQuery({
    queryKey: ['vibequest-characters'],
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from('characters')
          .select('*')
          .order('is_default', { ascending: false })
          .abortSignal(AbortSignal.timeout(6000));
        if (error || !data || data.length === 0) return LOCAL_CHARACTERS;
        return data as Character[];
      } catch {
        return LOCAL_CHARACTERS;
      }
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });
};
