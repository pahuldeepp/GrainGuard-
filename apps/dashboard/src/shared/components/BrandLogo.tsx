import logoUrl from "../../assets/grainguard-logo.svg";

interface BrandLogoProps {
  showWordmark?: boolean;
  markClassName?: string;
  wordmarkClassName?: string;
  className?: string;
}

export function BrandLogo({
  showWordmark = true,
  markClassName = "h-9 w-9",
  wordmarkClassName = "text-lg font-bold text-gray-900 dark:text-white",
  className = "flex items-center gap-3",
}: BrandLogoProps) {
  return (
    <div className={className}>
      <img
        src={logoUrl}
        alt="GrainGuard logo"
        className={`${markClassName} shrink-0`}
      />
      {showWordmark && <span className={wordmarkClassName}>GrainGuard</span>}
    </div>
  );
}
