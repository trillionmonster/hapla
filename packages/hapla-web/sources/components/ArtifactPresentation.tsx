import * as React from 'react';

// A collection owns the frame and row spacing; its contents must not add
// another card frame or the margins used by standalone conversation items.
export const ArtifactPresentation = React.createContext(false);
export const useGroupedArtifact = () => React.useContext(ArtifactPresentation);
