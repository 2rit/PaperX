import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Draws an ImageBitmap into a canvas sized to the bitmap; CSS controls display size. */
const BitmapCanvas = forwardRef<HTMLCanvasElement, { bitmap: ImageBitmap | null; className?: string; style?: React.CSSProperties; testId?: string }>(
  ({ bitmap, className, style, testId }, ref) => {
    const c = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => c.current!);
    useEffect(() => {
      const cv = c.current;
      if (!cv || !bitmap) return;
      if (cv.width !== bitmap.width || cv.height !== bitmap.height) {
        cv.width = bitmap.width;
        cv.height = bitmap.height;
      }
      cv.getContext('2d')!.drawImage(bitmap, 0, 0);
    }, [bitmap]);
    return <canvas ref={c} className={className} style={style} data-testid={testId} />;
  },
);
export default BitmapCanvas;
