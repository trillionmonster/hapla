export const gitWorkbenchCoreEnglish = {
    title: 'Changes', review: 'Review changes',
    contextUnknown: ({ tokens }: { tokens: string }) => `${tokens} tokens · capacity unknown`,
};
export const gitWorkbenchCoreChinese: typeof gitWorkbenchCoreEnglish = {
    title: '变更', review: '审阅变更',
    contextUnknown: ({ tokens }: { tokens: string }) => `${tokens} tokens · 容量未知`,
};
