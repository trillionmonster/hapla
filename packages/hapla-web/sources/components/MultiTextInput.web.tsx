import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import TextareaAutosize from 'react-textarea-autosize';
import { Typography } from '@/constants/Typography';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

export interface PastedImage {
    data: string; // base64
    mediaType: string; // e.g. 'image/png'
    previewData?: string;
    sourceFile?: File;
}

interface MultiTextInputProps {
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    accessibilityLabel?: string;
    minHeight?: number;
    maxHeight?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
    onPasteImages?: (images: PastedImage[]) => void;
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const { theme } = useUnistyles();
    const {
        value,
        onChangeText,
        placeholder,
        accessibilityLabel,
        minHeight,
        maxHeight = 120,
        lineHeight = theme.typography.body.lineHeight,
        onKeyPress,
        onSelectionChange,
        onStateChange,
        onPasteImages
    } = props;
    
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const maxRows = Math.floor(maxHeight / lineHeight);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!onKeyPress) return;

        const isComposing = e.nativeEvent.isComposing || (e.nativeEvent as any).isComposing || e.keyCode === 229;
        if (isComposing) {
            return;
        }

        const key = e.key;
        
        // Map browser key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: e.shiftKey
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [onKeyPress]);

    // Use native DOM event listener for reliable paste handling across browsers
    const onPasteImagesRef = React.useRef(onPasteImages);
    onPasteImagesRef.current = onPasteImages;

    React.useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleNativePaste = (e: ClipboardEvent) => {
            const cb = onPasteImagesRef.current;
            if (!cb) return;

            const clipboardData = e.clipboardData;
            if (!clipboardData) return;

            // Collect image files from both items and files (Safari fallback)
            const imageFiles: File[] = [];
            const imageTypes: string[] = [];

            // Try DataTransferItemList first (Chrome, Firefox)
            if (clipboardData.items && clipboardData.items.length > 0) {
                for (let i = 0; i < clipboardData.items.length; i++) {
                    const item = clipboardData.items[i];
                    if (item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) {
                            imageFiles.push(file);
                            imageTypes.push(item.type);
                        }
                    }
                }
            }

            // Fallback to clipboardData.files (Safari)
            if (imageFiles.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
                for (let i = 0; i < clipboardData.files.length; i++) {
                    const file = clipboardData.files[i];
                    if (file.type.startsWith('image/')) {
                        imageFiles.push(file);
                        imageTypes.push(file.type);
                    }
                }
            }

            if (imageFiles.length === 0) return;

            e.preventDefault();

            cb(imageFiles.map((file, index) => ({
                data: '',
                mediaType: imageTypes[index],
                sourceFile: file,
            })));
        };

        textarea.addEventListener('paste', handleNativePaste);
        return () => textarea.removeEventListener('paste', handleNativePaste);
    }, []);

    const handleChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const text = e.target.value;
        const selection = { 
            start: e.target.selectionStart, 
            end: e.target.selectionEnd 
        };
        
        onChangeText(text);
        
        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement;
        const selection = { 
            start: target.selectionStart, 
            end: target.selectionEnd 
        };
        
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
        if (onStateChange) {
            onStateChange({ text: value, selection });
        }
    }, [value, onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            if (textareaRef.current) {
                // Directly set value and selection on DOM element
                textareaRef.current.value = text;
                textareaRef.current.setSelectionRange(selection.start, selection.end);
                
                // Trigger React's onChange by dispatching an input event
                const event = new Event('input', { bubbles: true });
                textareaRef.current.dispatchEvent(event);
                
                // Also call callbacks directly for immediate update
                onChangeText(text);
                if (onStateChange) {
                    onStateChange({ text, selection });
                }
                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
            }
        },
        focus: () => {
            textareaRef.current?.focus();
        },
        blur: () => {
            textareaRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    return (
        <View style={{ width: '100%' }}>
            <TextareaAutosize
                ref={textareaRef}
                style={{
                    width: '100%',
                    padding: '0',
                    fontSize: `${theme.typography.body.fontSize}px`,
                    color: theme.colors.input.text,
                    border: 'none',
                    outline: 'none',
                    resize: 'none' as const,
                    backgroundColor: 'transparent',
                    fontFamily: Typography.default().fontFamily,
                    lineHeight: `${lineHeight}px`,
                    scrollbarWidth: 'none',
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                    minHeight,
                } as any}
                placeholder={placeholder}
                aria-label={accessibilityLabel}
                value={value}
                onChange={handleChange}
                onSelect={handleSelect}
                onKeyDown={handleKeyDown}
                maxRows={maxRows}
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
            />
        </View>
    );
});

MultiTextInput.displayName = 'MultiTextInput';
