import { useEffect, useState, useCallback, useRef } from 'react';

/**
 * 
 * @param value callback function to debounce
 * @param delay delay in milliseconds
 */

export function useDebounce<T>(value: T, delay = 500): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedValue(value)
        }, delay);

        return () => clearTimeout(timer);

    },  [value, delay]);

    return debouncedValue;
}

export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
    callback: T,
    delay: number
  ): (...args: Parameters<T>) => void {
    const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  
    return useCallback(
      (...args: Parameters<T>) => {
        const endTimeout = () => {
          clearTimeout(timeout.current);
          callback(...args);
        };
  
        clearTimeout(timeout.current);
        timeout.current = setTimeout(endTimeout, delay);
      },
      [callback, delay]
    );
  }

