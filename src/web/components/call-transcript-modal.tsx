// Modal that shows a call's full transcription in a scrollable panel.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transcription: string;
  title?: string;
};

export function CallTranscriptModal({
  open,
  onOpenChange,
  transcription,
  title,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? "Call transcript"}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-default bg-base p-3 text-sm text-primary">
          {transcription}
        </div>
      </DialogContent>
    </Dialog>
  );
}
