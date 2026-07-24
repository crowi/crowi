import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent, Avatar, AvatarFallback } from '@crowi/web';

export const MemberInfo = () => (
  <TooltipProvider>
    <Tooltip open>
      <TooltipTrigger asChild>
        <span className="relative inline-block">
          <Avatar>
            <AvatarFallback>AN</AvatarFallback>
          </Avatar>
        </span>
      </TooltipTrigger>
      <TooltipContent>Aki Nomura · editing</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
