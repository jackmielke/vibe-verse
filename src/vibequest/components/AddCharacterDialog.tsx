import { useState, useRef, DragEvent } from 'react';
import { supabase } from '@/vibequest/supabase';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Plus, Upload, ImageIcon } from 'lucide-react';

interface AddCharacterDialogProps {
  onCharacterAdded: () => void;
}

export const AddCharacterDialog = ({ onCharacterAdded }: AddCharacterDialogProps) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast({
        title: "Invalid file type",
        description: "Please select an image file",
        variant: "destructive",
      });
      return;
    }
    setImageFile(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageFile(file);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleImageFile(file);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          handleImageFile(file);
        }
        break;
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      toast({
        title: "Name required",
        description: "Please enter a character name",
        variant: "destructive",
      });
      return;
    }

    if (!imageFile) {
      toast({
        title: "Image required",
        description: "Please select a character image",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);

    try {
      // Upload image to storage
      const fileExt = imageFile.name.split('.').pop();
      const fileName = `${crypto.randomUUID()}.${fileExt}`;
      const filePath = `${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('character-images')
        .upload(filePath, imageFile);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('character-images')
        .getPublicUrl(filePath);

      // Insert character record
      const { error: insertError } = await supabase
        .from('characters')
        .insert({
          name: name.trim(),
          image_url: publicUrl,
          is_default: false,
        });

      if (insertError) throw insertError;

      toast({
        title: "Success!",
        description: `${name} has been added to the character roster`,
      });

      // Reset form and close dialog
      setName('');
      setImageFile(null);
      setImagePreview(null);
      setOpen(false);
      onCharacterAdded();
    } catch (error) {
      console.error('Error adding character:', error);
      toast({
        title: "Error",
        description: "Failed to add character. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  // Stop keyboard events from propagating to game engine
  const stopPropagation = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Plus className="w-4 h-4" />
          Add Character
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]" onKeyDown={stopPropagation}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add New Character</DialogTitle>
            <DialogDescription>
              Create a new character by providing a name and image
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Character Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={stopPropagation}
                placeholder="Enter character name"
                disabled={isUploading}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label>Character Image</Label>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onPaste={handlePaste}
                tabIndex={0}
                onKeyDown={stopPropagation}
                className={`
                  relative flex flex-col items-center justify-center 
                  min-h-[160px] p-6 rounded-lg border-2 border-dashed 
                  cursor-pointer transition-all duration-200
                  ${isDragging 
                    ? 'border-primary bg-primary/10 scale-[1.02]' 
                    : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/50'
                  }
                  ${isUploading ? 'opacity-50 pointer-events-none' : ''}
                `}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  disabled={isUploading}
                  className="hidden"
                />
                
                {imagePreview ? (
                  <div className="flex flex-col items-center gap-3">
                    <img
                      src={imagePreview}
                      alt="Preview"
                      className="max-h-24 object-contain rounded"
                    />
                    <p className="text-sm text-muted-foreground">Click or drop to replace</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="p-3 rounded-full bg-muted">
                      <ImageIcon className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        Drag & Drop or Click to Upload
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        You can also paste an image (Ctrl+V)
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isUploading} className="gap-2">
              {isUploading ? (
                <>Processing...</>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Add Character
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};