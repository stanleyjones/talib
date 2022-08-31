import { Button } from "@chakra-ui/react";

type PaginationItemProps = {
  isCurrent?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  colorScheme?: "teal";
};

export function PaginationItem({
  isCurrent = false,
  page,
  onPageChange,
  colorScheme,
}: PaginationItemProps) {
  if (isCurrent) {
    return (
      <Button
        size="sm"
        fontSize="xs"
        width="4"
        colorScheme={colorScheme}
        disabled
        _disabled={{
          bg: "white",
          color: "black",
          cursor: "pointer",
        }}
      >
        {page}
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      fontSize="xs"
      width="4"
      bg="gray.100"
      _hover={{
        bg: "gray.300",
      }}
      onClick={() => onPageChange(page)}
    >
      {page}
    </Button>
  );
}
