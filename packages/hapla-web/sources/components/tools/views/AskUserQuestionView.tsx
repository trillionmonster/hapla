import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { sessionAllow } from '@/sync/ops';
import { t } from '@/text';
import { useRequestSubmission } from '@/hooks/useRequestSubmission';
import Ionicons from '@expo/vector-icons/Ionicons';

interface QuestionOption {
    label: string;
    description: string;
}

interface Question {
    id?: string;
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect: boolean;
    isOther?: boolean;
    isSecret?: boolean;
    required?: boolean;
}

interface AskUserQuestionInput {
    questions: Question[];
    answerFormat?: 'codex';
    autoResolutionMs?: number | null;
    expiresAt?: number | null;
}

// Styles MUST be defined outside the component to prevent infinite re-renders
// with react-native-unistyles. The theme is passed as a function parameter.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: theme.typography.caption.fontSize,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: theme.typography.body.fontSize,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    textAnswer: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHigh,
        fontSize: theme.typography.label.fontSize,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44, // Minimum touch target for mobile
    },
    optionButtonSelected: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: theme.typography.label.fontSize,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: theme.typography.small.fontSize,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44, // Minimum touch target for mobile
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: theme.typography.label.fontSize,
        fontWeight: '600',
    },
    submittedContainer: {
        gap: 8,
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: theme.typography.small.fontSize,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    submittedValue: {
        fontSize: theme.typography.small.fontSize,
        color: theme.colors.text,
        flex: 1,
    },
}));

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<number, Set<number>>>(new Map());
    const [textAnswers, setTextAnswers] = React.useState<Map<number, string>>(new Map());
    const submission = useRequestSubmission(sessionId, tool.permission?.id, tool.permission?.status);
    const isSubmitting = submission.isBusy;

    // Parse input
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const isResolved = tool.permission?.status === 'approved' || tool.state === 'completed';
    const isExpired = tool.permission?.status === 'expired';
    const isCanceled = tool.permission?.status === 'canceled' || tool.permission?.status === 'denied' || tool.state === 'error';
    const canInteract = !!tool.permission && tool.state === 'running' && !isResolved && !isCanceled && !isExpired && !isSubmitting;
    React.useEffect(() => { setSelections(new Map()); setTextAnswers(new Map()); }, [tool.permission?.id]);

    // Check if all questions have at least one selection
    const allQuestionsAnswered = questions.every((question, qIndex) => {
        if (question.required === false) return true;
        const selected = selections.get(qIndex);
        const textAnswer = textAnswers.get(qIndex)?.trim();
        return !!((selected && selected.size > 0) || textAnswer);
    });

    const handleOptionToggle = React.useCallback((questionIndex: number, optionIndex: number, multiSelect: boolean) => {
        if (!canInteract) return;

        setSelections(prev => {
            const newMap = new Map(prev);
            const currentSet = newMap.get(questionIndex) || new Set();

            if (multiSelect) {
                // Toggle for multi-select
                const newSet = new Set(currentSet);
                if (newSet.has(optionIndex)) {
                    newSet.delete(optionIndex);
                } else {
                    newSet.add(optionIndex);
                }
                newMap.set(questionIndex, newSet);
            } else {
                // Replace for single-select
                newMap.set(questionIndex, new Set([optionIndex]));
            }

            return newMap;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async (answersSelection = selections) => {
        const complete = questions.every((question, index) => question.required === false || answersSelection.get(index)?.size || textAnswers.get(index)?.trim());
        if (!sessionId || !complete || !canInteract || isSubmitting) return;

        const answers: Record<string, string> | Record<string, { answers: string[] }> = {};
        questions.forEach((q, qIndex) => {
            const selected = answersSelection.get(qIndex);
            const selectedLabels = selected && selected.size > 0
                ? Array.from(selected)
                    .map(optIndex => q.options[optIndex]?.label)
                    .filter(Boolean)
                : [];
            const freeText = textAnswers.get(qIndex)?.trim();
            const values = [...selectedLabels, ...(freeText ? [freeText] : [])];
            if (input?.answerFormat === 'codex') {
                (answers as Record<string, { answers: string[] }>)[q.id ?? q.question] = { answers: values };
            } else {
                (answers as Record<string, string>)[q.question] = values.join(', ');
            }
        });

        const accepted = await submission.submit(() => sessionAllow(sessionId, tool.permission!.id, undefined, undefined, 'approved', { answers }));
        if (accepted) setTextAnswers((previous) => new Map([...previous].filter(([index]) => !questions[index]?.isSecret)));
    }, [sessionId, questions, selections, textAnswers, input?.answerFormat, canInteract, isSubmitting, tool.permission?.id, submission.submit]);

    if (questions.length === 0) return null;
    // A failed RPC leaves the answer editable. Only the authoritative state resolves it.
    if (isSubmitting) return <ToolSectionView><View style={styles.submittedContainer}><ActivityIndicator size="small" /><Text style={styles.submittedHeader}>正在提交，等待 Codex 确认</Text></View></ToolSectionView>;
    if (isExpired) return <ToolSectionView><Text style={styles.submittedHeader}>已超时</Text></ToolSectionView>;
    if (isCanceled) return <ToolSectionView><Text style={styles.submittedHeader}>已取消</Text></ToolSectionView>;

    // Show submitted state
    if (isResolved) {
        return (
            <ToolSectionView>
                <View style={styles.submittedContainer}>
                    {questions.map((q, qIndex) => {
                        const selected = selections.get(qIndex);
                        const selectedLabels = selected
                            ? Array.from(selected)
                                .map(optIndex => q.options[optIndex]?.label)
                                .filter(Boolean)
                                .join(', ')
                            : '';
                        const freeText = textAnswers.get(qIndex)?.trim() ?? '';
                        const displayAnswer = q.isSecret ? '••••••（已隐藏）' : [selectedLabels, freeText].filter(Boolean).join(', ') || '已解决';
                        return (
                            <View key={qIndex} style={styles.submittedItem}>
                                <Text style={styles.submittedHeader}>{q.header}:</Text>
                                <Text style={styles.submittedValue}>{displayAnswer}</Text>
                            </View>
                        );
                    })}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {questions.map((question, qIndex) => {
                    const selectedOptions = selections.get(qIndex) || new Set();

                    return (
                        <View key={qIndex} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {question.options.map((option, oIndex) => {
                                    const isSelected = selectedOptions.has(oIndex);

                                    return (
                                        <TouchableOpacity
                                            key={oIndex}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                !canInteract && styles.optionButtonDisabled,
                                            ]}
                                            accessibilityRole="button"
                                            accessibilityLabel={option.label}
                                            onPress={() => {
                                                handleOptionToggle(qIndex, oIndex, question.multiSelect);
                                                if (canInteract && questions.length === 1 && !question.multiSelect && !question.isSecret && !textAnswers.get(qIndex)?.trim()) {
                                                    void handleSubmit(new Map([[qIndex, new Set([oIndex])]]));
                                                }
                                            }}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && (
                                                        <Ionicons name="checkmark" size={14} color="#fff" />
                                                    )}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
                                                    {isSelected && <View style={styles.radioInner} />}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description && (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                )}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                {(question.options.length === 0 || question.isOther) && (
                                    <TextInput
                                        style={styles.textAnswer}
                                        value={textAnswers.get(qIndex) ?? ''}
                                        onChangeText={(value) => setTextAnswers((previous) => {
                                            const next = new Map(previous);
                                            next.set(qIndex, value);
                                            return next;
                                        })}
                                        placeholder={question.options.length === 0 ? '输入你的回答' : '其他回答'}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        editable={canInteract}
                                        secureTextEntry={question.isSecret}
                                        accessibilityLabel={`${question.header} 回答`}
                                    />
                                )}
                            </View>
                        </View>
                    );
                })}

                {submission.error && <Text accessibilityRole="alert" style={styles.submittedHeader}>{submission.error}</Text>}
                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={() => void handleSubmit()}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});
